# Checkout expansion increment

The prototype now supports explicit, atomic, candidate-bound grant expansion in both
scoped arms. The graph wrapper protects new impacting/impacted dependencies; the block
arm uses the same authorization core with no dependency expansion. Neither publishes
at expansion time. Conflicts leave the original live grant intact. Stale bases require
another edit attempt, and the expanded candidate still needs common behavior validation.

See the [contract](checkout-arbiter-prototype.md#candidate-bound-expansion) and
[follow-up protocol](checkout-comparison-protocol.md#expansion-follow-up-amendment).
The native bridge and deterministic runner use this API, explicitly request introduced
helpers/imports, and retain the original scope refusal, expansion and final submission.
This remains a local in-memory experiment with trusted identity/clock/catalog producers.

Sixteen model-free regressions cover expansion, conflicts and rollback, fresh bases,
ownership/expiry, independent paths, candidate binding, validation, unrelated edits,
subrange/new-file refusal, both runner arms, expired requests before producer work,
producer-error refusals and assigned-path authority. The blank-line regression treats an
insertion inside an unrelated template literal as a data modification; only blank gaps
adjoining a newly granted block are permitted. The full Node 26 suite passed **870/870**
in `artifacts/checkout-expansion-node26-tests-v4.tap`, including final native adapter
verification. Earlier 867-test core verification remains retained separately.

Actual producer qualification passed all 13 lab scenarios, 24 independent binding
cases and the original same-file merge/outside-scope checks, retained in
`artifacts/checkout-expansion-qualification-v1`. Added coverage handles `Math.min`,
`Number.isInteger`, contained named helpers and single-parameter arrows. Shadows,
reassignment, dynamic dispatch and arbitrary object methods remain conservative refusals.

Both previously refused V4.1 helper candidates now expand and publish under common
legacy validation in `artifacts/checkout-retained-helper-qualification-v1`: inventory's
`aggregate` and records' `assertOrderRecord`. This is a focused API qualification with
reconstructed bases: only the tested role's files are restored to the seed, while other
source comes from that retained candidate. It is not a resumed model trial and changes
none of the original native success scores. No new model calls ran in this increment.

The first replay attempt overlapped full-suite mutation tests, was stopped, and is
retained as invalid apparatus in `artifacts/checkout-expansion-comparison-v1`, including
all 108 assignments and 18 completed outcomes. The second completed 108/108 with no
apparatus errors and verified all 14 recorded implementation hashes. Its code snapshots
and results are retained in `artifacts/checkout-expansion-comparison-v2`. A subsequent
scope-security regression prompted a final fresh run after core tests and qualification
finished. That run is retained separately as `v3`: all 108 assignments completed,
zero apparatus failures, and all 14 recorded runtime fingerprints verified. Native
adapter hardening is outside this model-free replay's runtime fingerprint scope and
was tested separately. All campaigns remain retained with their own implementation
snapshots; no outcomes were pooled across versions.

The final v3 comparison recovered all new-import outcomes: current 30/36,
blocks 30/36 (previously 24), graph 28/36 (previously 22). The original six missions,
schedules, edits and held checks did not change. Graph still excludes all six unknown
callback outcomes and still loses two reverse-order cases where later provider changes
invalidate a completed consumer. Four dependency-sensitive cases continue to recover
relative to current/block. This is a mechanism improvement, not an established overall
advantage: graph remains two correct outcomes behind current rules. Virtual work ticks
are not native agent time; deterministic repeats are not independent model samples.

| Arm | Before expansion | After expansion | Final all-published-but-wrong | Waiting ticks | Rejected work ticks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current | 30/36 | 30/36 | 6 | 0 | 80 |
| Blocks | 24/36 | 30/36 | 6 | 60 | 40 |
| Graph | 22/36 | 28/36 | 2 | 120 | 60 |

The follow-up changes both scope handling and bounded producer coverage; these data do
not isolate the effect of each independently. The original six new-import outcomes per
scoped arm were recovered. Median first-correct virtual ticks are current/blocks 10,
graph 20. Measured local policy medians are 1,073/2,295/2,151 milliseconds respectively;
they include nested validation/producer time and must not be summed with those columns.
Additional expansion builds therefore have a real local cost even when synthetic worker
ticks remain unchanged. The full source/AST/validation records remain under the run root.

The next evaluation was a fresh V4.1 comparison with varied shared missions, including
dependency-sensitive adaptation and previously independent work. That
[study has now completed](checkout-varied-results.md): current 3/9 correct, blocks 1/9,
graph 2/9, with no overall improvement. Its tasks, references and implementation were
frozen before admission. These deterministic results and the earlier single-mission
native pilot remain separate; no RT-1 qualification follows.
