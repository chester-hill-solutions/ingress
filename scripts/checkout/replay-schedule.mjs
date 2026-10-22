// A deterministic virtual worker schedule, not elapsed agent time. All real I/O and
// clocks are supplied outside; checker access is confined to the evaluator.
//
// The schedule also models the workspace's invalidation notice. When the workspace
// reports that an already-published output was invalidated, the owner regenerates it
// from a current base: it takes a fresh checkout, re-derives its edit from that base
// and publishes again. The workspace never re-approves an invalidated output on its
// own, so the only recovery available to a worker is to do the work again.
export const schedules = [
  { id: 'forward', acquire: [0, 1], finish: [0, 1] },
  { id: 'reverse', acquire: [1, 0], finish: [1, 0] },
  { id: 'contended-first', acquire: [0, 1], finish: [1, 0] },
];
export async function replaySchedule({ workload, schedule, api, patch, acceptance, deadlineTicks = 40, maxAttempts = 3, maxRegenerations = 2 }) {
  const jobs = workload.tasks.map(task => ({ task, status: 'pending', attempts: 0, waitingTicks: 0, rejectedWorkTicks: 0 }));
  const events = []; let tick = 0, publications = 0, firstCorrectTick = null, regressions = 0;
  const invalidations = [];
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
      job.grant = grant;
      // A worker that is regenerating an invalidated output redoes its own work: the
      // edit is recomputed against the version of its own file it started from, with
      // the current values of the inputs it reads. The frozen transformation is not
      // idempotent, so re-applying it to the file that already carries its previous
      // output would insert a second copy and leave the stale one winning. This
      // models a worker that rewrites its change; it is a stated modelling choice
      // and not a measurement of agent behaviour.
      const base = job.pendingRegeneration && job.origin ? { ...grant.files, ...job.origin } : grant.files;
      const applied = patch(job.task, structuredClone(base));
      job.patch = applied.files;
      job.reads = applied.reads ?? [];
      job.origin ??= { [job.task.path]: grant.files[job.task.path] };
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
      let result = await api.submit(job.grant, job.patch, tick, job.reads);
      event('submit', job, result);
      if (api.expand && ['scope_expansion_required', 'outside_modification_scope'].includes(result.reason)) {
        const expanded = await api.expand(job.grant, job.patch, tick);
        event('expansion', job, expanded);
        result = expanded.expanded ? await api.submit(job.grant, job.patch, tick, job.reads) : expanded;
        if (expanded.expanded) event('submit-expanded', job, result);
      }
      if (result.admitted) {
        const previous = job.publishedFiles;
        job.publishedFiles = { ...job.patch };
        job.status = 'done'; job.completedAt = tick; publications++;
        if (job.pendingRegeneration) {
          job.regenerationChangedOutput = previous?.[job.task.path] !== job.patch[job.task.path];
          job.pendingRegeneration = false;
        }
        const correct = await acceptance((await api.snapshot()).files);
        if (correct && firstCorrectTick === null) firstCorrectTick = tick;
        if (priorCorrect && !correct) regressions++;
        priorCorrect = correct;
        // The workspace may have invalidated an output that was already published --
        // including this one, if it was built against a provider version that has since
        // moved. The owner regenerates; the workspace does not re-approve it.
        for (const path of api.takeInvalidated?.() ?? []) {
          const owner = jobs.find(other => other.task.path === path && other.status === 'done');
          if (!owner) continue;
          invalidations.push({ tick, path, task: owner.task.id });
          if ((owner.regenerations ?? 0) >= maxRegenerations) {
            owner.status = 'failed'; owner.reason = 'invalidation_budget_exhausted';
            continue;
          }
          owner.regenerations = (owner.regenerations ?? 0) + 1;
          owner.regeneratedWorkTicks = (owner.regeneratedWorkTicks ?? 0) + owner.task.workTicks;
          owner.pendingRegeneration = true;
          owner.status = 'pending';
          delete owner.grant;
        }
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
  return { events, jobs: jobs.map(({ task, grant, patch, finishAt, waitSince, lastPublication, publishedFiles, pendingRegeneration, ...job }) => ({ id: task.id, ...job })),
    finalFiles: state.files, finalCorrect, firstCorrectTick, settlementTick: tick, publications, regressions,
    invalidations, invalidatedOutputs: api.invalidatedOutputs?.() ?? [],
    waitingTicks: jobs.reduce((n, job) => n + job.waitingTicks, 0),
    rejectedWorkTicks: jobs.reduce((n, job) => n + job.rejectedWorkTicks, 0),
    regeneratedWorkTicks: jobs.reduce((n, job) => n + (job.regeneratedWorkTicks ?? 0), 0),
    regenerations: jobs.reduce((n, job) => n + (job.regenerations ?? 0), 0),
    allPublished: jobs.every(job => job.status === 'done') };
}
