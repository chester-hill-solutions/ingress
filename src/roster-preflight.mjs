/**
 * Roster preflight: refuse to start a roster that cannot be decomposed.
 *
 * A recorded 17-agent run assigned 8 actors work and gave 9 of them no workstream
 * at all. `configureMission` computes `perActor = workstreams.length / agentCount`
 * and slices, so any agentCount that does not evenly divide the workstream count
 * yields empty slices. Those actors still burned their full budget producing
 * nothing. That is a property of the task, not of the agents, and it is
 * detectable before a single model call.
 *
 * Two assertions, each of which has an observed real-world failure:
 *
 *   1. every actor receives at least one workstream
 *   2. no two actors' declared paths overlap, unless overlap is declared
 *
 * Both fail loudly and name the actors involved. Neither is allowed to degrade
 * into a count of zero, which is the failure mode recorded against four gates in
 * the sibling repository that scanned a path that did not exist and reported 0.
 */

// A roster may exceed its workstream count only if it says so, by declaring
// which paths are shared. Anything else is an undeclared overlap.
export function preflightRoster({ tasks, workstreamCount, declaredOverlap = [] }) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError('roster requires tasks');
  if (!Number.isSafeInteger(workstreamCount) || workstreamCount < 1) throw new TypeError('workstreamCount must be a positive integer');
  if (!Array.isArray(declaredOverlap)) throw new TypeError('declaredOverlap must be an array');

  const unscoped = [];
  const scopeOf = new Map();

  for (const task of tasks) {
    if (typeof task?.id !== 'string' || !task.id) throw new TypeError('task requires an id');
    // `role` is the '+'-joined workstream ids this actor was assigned.
    const assigned = typeof task.role === 'string' && task.role.length ? task.role.split('+').filter(Boolean) : [];
    if (assigned.length === 0) unscoped.push(task.id);
    scopeOf.set(task.id, new Set(assigned));
  }

  // Two actors sharing a workstream is an overlap. Sharing a file path without
  // sharing a workstream is a declared/undeclared distinction the mission must
  // resolve explicitly, so both are reported, distinguished.
  const pathOwners = new Map();
  for (const task of tasks) {
    const scope = scopeOf.get(task.id);
    for (const path of task.files ?? []) pathOwners.set(path, [...(pathOwners.get(path) ?? []), task.id]);
  }
  const undeclaredOverlap = [];
  for (const [path, owners] of pathOwners) {
    if (owners.length < 2) continue;
    if (!declaredOverlap.includes(path)) undeclaredOverlap.push({ path, owners });
  }

  const assignedTotal = tasks.length - unscoped.length;
  const complete = unscoped.length === 0 && undeclaredOverlap.length === 0;

  return {
    roster: tasks.length,
    workstreamCount,
    assignedActors: assignedTotal,
    unscopedActors: unscoped,
    undeclaredOverlap,
    // Explicitly derived, never assumed. An unscoped actor is not "coverage".
    coverage: { complete, reason: complete ? null : unscoped.length ? 'roster_exceeds_decomposable_workstreams' : 'undeclared_scope_overlap' },
    verdict: complete ? 'admit' : 'refuse',
    // The specific arithmetic that produced the split, so the failure is legible.
    assignment: { perActor: workstreamCount / tasks.length, dividesEvenly: workstreamCount % tasks.length === 0 },
  };
}