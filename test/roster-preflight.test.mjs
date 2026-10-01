import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightRoster } from '../src/roster-preflight.mjs';
import { missionFixtures, validateMission } from '../fixtures/missions.mjs';
import { configureMission } from '../fixtures/mission-configurations.mjs';

/** Rebuild the assignment `configureMission` performs, for any roster size. */
function roster(base, agentCount) {
  const perActor = base.workstreams.length / agentCount;
  return Array.from({ length: agentCount }, (_, index) => {
    const streams = base.workstreams.slice(index * perActor, (index + 1) * perActor);
    return {
      id: `builder-${index + 1}`,
      role: streams.map(stream => stream.id).join('+'),
      files: [...new Set(streams.flatMap(stream => stream.paths))],
    };
  });
}

test('the recorded 17-agent roster is refused and the 9 unscoped actors are named', () => {
  // This is the configuration that produced the recorded run: 17 actors over
  // 8 workstreams. It must not be admissible.
  const base = missionFixtures[0];
  assert.equal(base.workstreams.length, 8);
  const report = preflightRoster({ tasks: roster(base, 17), workstreamCount: 8 });

  assert.equal(report.verdict, 'refuse');
  assert.equal(report.coverage.complete, false);
  assert.equal(report.coverage.reason, 'roster_exceeds_decomposable_workstreams');
  // 17 actors, 8 workstreams at 0.47 each: 9 slices are empty.
  assert.equal(report.unscopedActors.length, 9);
  assert.equal(report.assignedActors, 8);
  assert.deepEqual(report.unscopedActors, ['builder-1', 'builder-2', 'builder-4', 'builder-6', 'builder-8', 'builder-10', 'builder-12', 'builder-14', 'builder-16']);
  // The arithmetic must be reported, not inferred.
  assert.equal(report.assignment.dividesEvenly, false);
  assert.equal(report.assignment.perActor, 8 / 17);
});

test('every roster size that divides the workstream count still admits on scope', () => {
  // Divisibility is necessary but not sufficient. Every preregistered roster size
  // partitions the workstreams cleanly, so `unscopedActors` must be empty. The
  // real fixtures additionally declare overlapping paths, which is asserted
  // separately below rather than papered over here.
  for (const base of missionFixtures) {
    for (const size of [1, 2, 4, 8]) {
      const report = preflightRoster({ tasks: roster(base, size), workstreamCount: base.workstreams.length });
      assert.equal(report.unscopedActors.length, 0, `${base.id} at ${size} must scope every actor`);
      assert.equal(report.assignment.dividesEvenly, true);
      assert.equal(report.assignedActors, size);
    }
  }
});

test('the real mission fixtures declare overlapping paths, which the gate refuses', () => {
  // Observed, not assumed. Every preregistered mission shares output paths
  // between workstreams: `outputs/report.md` is claimed by all eight actors at
  // roster 8. This is why the recorded runs could not attribute a failure to an
  // actor, and it was never caught before a model ran.
  const base = missionFixtures[0];
  const report = preflightRoster({ tasks: roster(base, 8), workstreamCount: base.workstreams.length });

  assert.equal(report.verdict, 'refuse');
  assert.equal(report.coverage.reason, 'undeclared_scope_overlap');
  assert.equal(report.unscopedActors.length, 0);

  const shared = report.undeclaredOverlap.find(value => value.path === 'outputs/report.md');
  assert.ok(shared, 'report.md overlap must be reported');
  assert.equal(shared.owners.length, 8);

  // Declaring the overlap admits it. This is the honest fix: the missions
  // intentionally share output, so the gate has to be told that rather than
  // forced to pretend the scopes are disjoint.
  const declared = [...new Set(report.undeclaredOverlap.map(value => value.path))];
  const admitted = preflightRoster({ tasks: roster(base, 8), workstreamCount: 8, declaredOverlap: declared });
  assert.equal(admitted.verdict, 'admit');
  assert.deepEqual(admitted.undeclaredOverlap, []);
});

test('an undeclared path overlap is refused and every contending owner is named', () => {
  const base = missionFixtures[0];
  const shared = base.workstreams[0].paths[0];
  const tasks = roster(base, 8);
  // Force two otherwise-disjoint actors onto the same path.
  tasks[1] = { ...tasks[1], files: [...new Set([...tasks[1].files, shared])] };
  const report = preflightRoster({ tasks, workstreamCount: 8 });

  assert.equal(report.verdict, 'refuse');
  assert.equal(report.coverage.reason, 'undeclared_scope_overlap');
  const hit = report.undeclaredOverlap.find(value => value.path === shared);
  assert.ok(hit, 'overlapping path must be reported');
  assert.equal(hit.owners.length, 2);
  // Unscoped is still zero: the two failure modes are distinguishable.
  assert.equal(report.unscopedActors.length, 0);
});

test('an overlap that is declared up front is admitted', () => {
  const base = missionFixtures[0];
  const tasks = roster(base, 8);
  // Declare every path the fixture genuinely shares. Declaring only the path
  // this test added would leave the fixture's own overlaps undeclared, and the
  // gate would still refuse for those, correctly.
  const raw = preflightRoster({ tasks, workstreamCount: base.workstreams.length });
  const declared = [...new Set(raw.undeclaredOverlap.map(value => value.path))];
  assert.ok(declared.length > 0, 'fixture must have real overlaps to declare');

  const admitted = preflightRoster({ tasks, workstreamCount: 8, declaredOverlap: declared });
  assert.equal(admitted.verdict, 'admit');
  assert.deepEqual(admitted.undeclaredOverlap, []);
  assert.equal(admitted.coverage.complete, true);
});

test('a newly introduced overlap is still refused when other overlaps are declared', () => {
  // Guards the guard: pre-declaring one path's shared status must not grant a
  // blanket pass for a different path that becomes contended afterwards.
  // `exact-circulation` is fully disjoint at roster 8 (verified below), so any
  // overlap here is genuinely introduced by this test.
  const base = missionFixtures.find(fixture => fixture.workstreams.length === 8
    && new Set(fixture.workstreams.flatMap(s => s.paths)).size === 8);
  assert.ok(base, 'a disjoint mission fixture is required for this falsification');

  const tasks = roster(base, 8);
  const clean = preflightRoster({ tasks, workstreamCount: 8 });
  assert.equal(clean.verdict, 'admit', 'fixture must start disjoint');
  assert.deepEqual(clean.undeclaredOverlap, []);

  // Introduce a genuine second owner for builder-1's path.
  const intruder = tasks[0].files[0];
  tasks[1] = { ...tasks[1], files: [...new Set([...tasks[1].files, intruder])] };

  const report = preflightRoster({ tasks, workstreamCount: 8, declaredOverlap: [] });
  assert.equal(report.verdict, 'refuse');
  const hit = report.undeclaredOverlap.find(value => value.path === intruder);
  assert.ok(hit, 'the newly introduced overlap must be caught');
  assert.deepEqual(hit.owners.sort(), [tasks[0].id, tasks[1].id].sort());
});

test('mission fixtures split into disjoint and fully-shared, and the gate tells them apart', () => {
  // Observed across the six real missions: some share every output path, some
  // are fully disjoint. Counted the way the gate counts — by whether two actors
  // end up owning the same path — rather than by comparing totals, which
  // conflates "8 paths over 8 streams" with "8 paths but two are shared".
  const verdictOf = base => {
    const raw = preflightRoster({ tasks: roster(base, 8), workstreamCount: 8 });
    return { refuses: raw.verdict === 'refuse', overlaps: raw.undeclaredOverlap.length };
  };
  const verdicts = missionFixtures.map(verdictOf);
  const disjoint = verdicts.filter(v => !v.refuses).length;
  const shared = verdicts.filter(v => v.refuses).length;
  assert.equal(disjoint + shared, missionFixtures.length);
  assert.ok(disjoint >= 1, `at least one mission must be disjoint, saw ${disjoint}`);
  assert.ok(shared >= 1, `at least one mission must share paths, saw ${shared}`);

  // Every refusal must name a path and at least two owners.
  for (const base of missionFixtures) {
    const raw = preflightRoster({ tasks: roster(base, 8), workstreamCount: 8 });
    for (const overlap of raw.undeclaredOverlap) {
      assert.ok(overlap.path.length > 0, base.id);
      assert.ok(overlap.owners.length >= 2, `${base.id} ${overlap.path}`);
    }
  }
});

test('an empty roster or missing workstream count is an error, not a pass', () => {
  // Unresolvable input must not be reported as coverage.
  assert.throws(() => preflightRoster({ tasks: [], workstreamCount: 8 }), TypeError);
  assert.throws(() => preflightRoster({ tasks: roster(missionFixtures[0], 2), workstreamCount: 0 }), TypeError);
  assert.throws(() => preflightRoster({ tasks: roster(missionFixtures[0], 2), workstreamCount: 1.5 }), TypeError);
  assert.throws(() => preflightRoster({ tasks: [{ role: 'x' }], workstreamCount: 1 }), TypeError);
  assert.throws(() => preflightRoster({ tasks: roster(missionFixtures[0], 2), workstreamCount: 8, declaredOverlap: 'yes' }), TypeError);
});

test('the gate goes red on a planted violation rather than reporting zero', () => {
  // A gate that cannot fail is decoration. Strip every workstream from every
  // actor: the verdict must refuse, not degrade to a clean count.
  const base = missionFixtures[0];
  const stripped = roster(base, 8).map(task => ({ ...task, role: '' }));
  const report = preflightRoster({ tasks: stripped, workstreamCount: 8 });

  assert.equal(report.verdict, 'refuse');
  assert.equal(report.unscopedActors.length, 8);
  assert.equal(report.assignedActors, 0);
  assert.equal(report.coverage.complete, false);
});

test('declared-scope preflight is checked against the real mission fixtures', () => {
  // At the largest preregistered roster every actor is scoped. Whether the run
  // may start depends on declared overlap, which the real missions do have and
  // which the test above pins down explicitly.
  for (const base of missionFixtures) {
    assert.equal(validateMission(base), base);
    const tasks = roster(base, 8);
    const raw = preflightRoster({ tasks, workstreamCount: base.workstreams.length });
    assert.equal(raw.unscopedActors.length, 0, base.id);
    const declared = [...new Set(raw.undeclaredOverlap.map(value => value.path))];
    assert.equal(
      preflightRoster({ tasks, workstreamCount: base.workstreams.length, declaredOverlap: declared }).verdict,
      'admit', base.id);
  }
});

test('configureMission rosters at 8 scope every actor, so the gate does not break the study', () => {
  // The gate must not reject the assignment the existing 269-test study relies on.
  for (const base of missionFixtures) {
    const configured = configureMission(base, 'ingress-eight');
    const tasks = configured.tasks.map(task => ({ id: task.id, role: task.role, files: [] }));
    const raw = preflightRoster({ tasks, workstreamCount: base.workstreams.length });
    assert.equal(raw.unscopedActors.length, 0, base.id);
    assert.equal(raw.assignedActors, configured.tasks.length);
  }
});