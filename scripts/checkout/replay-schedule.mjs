// A deterministic virtual worker schedule, not elapsed agent time. All real I/O and
// clocks are supplied outside; checker access is confined to the evaluator.
export const schedules = [
  { id: 'forward', acquire: [0, 1], finish: [0, 1] },
  { id: 'reverse', acquire: [1, 0], finish: [1, 0] },
  { id: 'contended-first', acquire: [0, 1], finish: [1, 0] },
];
export async function replaySchedule({ workload, schedule, api, patch, acceptance, deadlineTicks = 40, maxAttempts = 3 }) {
  const jobs = workload.tasks.map(task => ({ task, status: 'pending', attempts: 0, waitingTicks: 0, rejectedWorkTicks: 0 }));
  const events = []; let tick = 0, publications = 0, firstCorrectTick = null, regressions = 0;
  let priorCorrect = await acceptance((await api.snapshot()).files);
  if (priorCorrect) throw new Error('seed_already_satisfies_goal');
  const event = (phase, job, result) => {
    const { files, checkoutId, participantId, ...summary } = result;
    events.push({ tick, task: job.task.id, phase, ...summary });
  };
  async function acquire(job) {
    job.attempts++;
    const grant = await api.checkout(job.task, job.task.id, tick);
    event('checkout', job, grant);
    if (grant.granted) {
      if (job.waitSince !== undefined) job.waitingTicks += tick - job.waitSince;
      delete job.waitSince;
      job.grant = grant; job.patch = patch(job.task, structuredClone(grant.files));
      job.finishAt = tick + job.task.workTicks; job.status = 'running';
    } else if (grant.reason === 'checkout_conflict') {
      job.waitSince ??= tick; job.lastPublication = publications; job.status = 'blocked'; job.attempts--;
    } else { job.status = 'failed'; job.reason = grant.reason; }
  }
  for (const position of schedule.acquire) await acquire(jobs[position]);
  while (tick < deadlineTicks && jobs.some(job => ['running', 'blocked', 'pending'].includes(job.status))) {
    const running = jobs.filter(job => job.status === 'running');
    if (!running.length) break;
    tick = Math.min(...running.map(job => job.finishAt));
    if (tick > deadlineTicks) { tick = deadlineTicks; break; }
    for (const position of schedule.finish) {
      const job = jobs[position];
      if (job.status !== 'running' || job.finishAt !== tick) continue;
      let result = await api.submit(job.grant, job.patch, tick);
      event('submit', job, result);
      if (api.expand && ['scope_expansion_required', 'outside_modification_scope'].includes(result.reason)) {
        const expanded = await api.expand(job.grant, job.patch, tick);
        event('expansion', job, expanded);
        result = expanded.expanded ? await api.submit(job.grant, job.patch, tick) : expanded;
        if (expanded.expanded) event('submit-expanded', job, result);
      }
      if (result.admitted) {
        job.status = 'done'; job.completedAt = tick; publications++;
        const correct = await acceptance((await api.snapshot()).files);
        if (correct && firstCorrectTick === null) firstCorrectTick = tick;
        if (priorCorrect && !correct) regressions++;
        priorCorrect = correct;
      } else {
        job.rejectedWorkTicks += job.task.workTicks;
        await api.release(job.grant, tick);
        job.reason = result.reason;
        job.status = job.attempts < maxAttempts && ['merge_conflict', 'lease_required', 'validation_failed', 'expansion_base_moved', 'checkout_conflict'].includes(result.reason) ? 'pending' : 'failed';
      }
    }
    for (const position of schedule.acquire) {
      const job = jobs[position];
      if (job.status === 'pending' || job.status === 'blocked' && job.lastPublication !== publications) await acquire(job);
    }
  }
  for (const job of jobs) {
    if (job.waitSince !== undefined) job.waitingTicks += tick - job.waitSince;
    if (job.status === 'running') await api.release(job.grant, tick);
    if (['running', 'pending', 'blocked'].includes(job.status)) { job.status = 'deadline'; job.reason ??= 'deadline_or_no_progress'; }
  }
  const state = await api.snapshot(), finalCorrect = await acceptance(state.files);
  return { events, jobs: jobs.map(({ task, grant, patch, finishAt, waitSince, lastPublication, ...job }) => ({ id: task.id, ...job })),
    finalFiles: state.files, finalCorrect, firstCorrectTick, settlementTick: tick, publications, regressions,
    waitingTicks: jobs.reduce((n, job) => n + job.waitingTicks, 0),
    rejectedWorkTicks: jobs.reduce((n, job) => n + job.rejectedWorkTicks, 0),
    allPublished: jobs.every(job => job.status === 'done') };
}
