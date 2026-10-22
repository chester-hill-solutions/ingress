# Agent Collaboration implementation plan

# Ingress implementation plan

Engineering on the deployed product surface (`src/product/`, `src/worker.js`) follows the
[product hardening plan](product-hardening-plan.md). It is an ordered queue, not a
capability claim, and it records three findings that contradict claims the code comments
make. The rest of this document is the research plan and is unaffected by it.

Stow storage release work is separate.
The [repository boundary](realtime-repository-boundary.md) now distinguishes Stow-owned
storage facts/durable delivery from Ingress-owned agent meaning, context and coordination.
Notification integration follows qualified public Stow capabilities; the standalone
observer remains available. This scope clarification changes no RT completion status.
See [product](realtime-multiplayer-plan.md), [engineering](realtime-multiplayer-engineering.md),
[evaluation](realtime-collaboration-evaluation.md) and [review](realtime-multiplayer-plan-review.md).
The [Cloudflare platform plan](cloudflare-platform-plan.md) records the platform primitives
this repository qualifies as a host and scopes a separate competition entry; it advances
no RT status. The [claim protocol](claim-protocol.md) proposes replacing agent-to-agent
conversation with materialized claim records; its attribution mechanism was
refuted against recorded data and that correction is recorded there.
The [roster preflight](roster-preflight.md) is implemented and gates roster
construction. The [rename record](rename-to-ingress.md) is prior provenance for
the product name.

## Current work

- Versioned publication evidence and dependent-output invalidation (2026-10-22): the
  mechanism the source-control design input named as the next thing to qualify is
  built (`src/prototypes/checkout/invalidation.mjs`), tested without Python, a model
  or a deployment, and measured on a paired campaign: the same 108 assignments run
  with the mechanism off and on, in one run over one implementation. The finding that
  shaped it is that the dependency relation the mechanism needs is *not* in the code
  graph — it is a data dependency with no import edge — so the evidence has to come
  from the participant's own declared inputs, which the product already carries as
  `builtFrom`. Publication-time checks and invalidation are not substitutes: the
  forward order is caught by a read check, the reverse order only by invalidation.
  The recovery policy is a stated model of a worker, not a measurement of one.
  No deployed route, admission rule, durable record or RT status changed; the
  product-side form is hardening queue item 14, slice 4, and is still open. See
  [the invalidation results](checkout-invalidation-results.md).
- User-directed checkout experiment (2026-10-12): a separate memory-only block arbiter
  and optional EmbeddingGemma 2 discovery/comparison. Exclusive modification grants
  explore a new design beyond the observer's no-claims contract; no deployed routes,
  filesystem-isolation claim or RT qualification changes. See the
  [prototype contract and evidence](checkout-arbiter-prototype.md). The user's Graphify
  proposal now has a six-slice implementation sequence and product queue item 14;
  real code extraction and a bounded lab admission adapter have now been exercised;
  authenticated durable integration remains open.
  Embeddings are excluded from the planned v1 runtime; the optional prior experiment
  and every assigned result remain retained.
  Graphify 0.9.62 has now been probed on 24 pinned product modules: 37/38 qualifier
  checks passed, with a false imported-call target under parameter shadowing. An AST
  sidecar mapped all 170 callable ranges; binding/parse/coverage guards remain required
  before this graph can authorize a product checkout. The suite passed 784/784 at that checkpoint.
  A standalone `checkout-arbiter-lab` repository now provides a 16-module order workflow,
  19 baseline checks, two explicit data contracts and 13 oracle-only checkout scenarios.
  Three candidate mutation replays passed their expected behavior/syntax checks. The
  lab's code-only Graphify pass reproduces the shadowed-import false edge; this is a
  regression target, not a qualified graph authority or real-model trial.
  That checkpoint passed 803/803 with the lab's 19 checks included.
  The bounded graph adapter now drives the actual arbiter: all 13 checkout scenarios,
  15 fresh adversarial binding cases and the concurrent same-file publication/outside
  scope checks passed on Node 26. Raw Graphify shadowing is rejected; unresolved calls
  remain conservative refusals. The 35 new deterministic regressions require only Node.
  The full Node 26 suite passed 838/838 and repository checks passed.
  Records are retained in `artifacts/checkout-qualification-v3`; no deployed routes,
  authenticated durable grants or real-model assignments were added.
- Checkout mechanism comparison (2026-10-12): all 108 frozen assignments completed
  with zero apparatus failures in the admitted run. Correct missions: current 30/36,
  block scopes 24/36, graph scopes 22/36. The graph recovered four dependency-sensitive
  outcomes but lost twelve to absent scope expansion and unknown callback exclusion.
  Two reverse-order dependent outputs still became stale after publication. This is
  not an overall improvement on the selected deterministic campaign; no live models
  ran and no RT status changes. Both preflight failures remain retained separately.
  See [results and limits](checkout-comparison-results.md) and
  [frozen protocol](checkout-comparison-protocol.md). The subsequent native pilot
  implements the working-copy/grant bridge for the bounded lab experiment.
  The full Node 26 suite passed 842/842; boundary/link and whitespace checks passed.
- Native checkout pilot (2026-10-12): user-selected OpenCode DeepSeek V4 Flash.
  Actual private-copy/submission bridge and a 14-group independent mission grader
  are implemented locally; seed/reference and isolation checks pass. Three retained
  two-actor preflight attempts yielded one successful private-file edit and five
  provider.invalid-request HTTP 404 failures before tokens. All servers stopped;
  none of the nine planned comparative cohorts were admitted. Source payload is the
  verified synthetic lab only. The full suite passed 845/845. The user then selected
  V4.1 Flash explicitly. Its fresh campaign completed all nine cohorts/36 actors:
  current rules 2/3 correct missions, blocks 2/3, graph 1/3. Median settlement was
  133.5/85.3/266.0 seconds respectively; graph used 30 native turns versus 12 per other
  arm. Nine changed-base, nine unresolved-call and two scope-expansion refusals were
  retained. All cohorts stopped within budget, all 12 recorded implementation hashes
  verified. One small mission does not establish useful benefit; no RT change.
  See [native evidence and limitations](checkout-native-results.md).
- Repository separation: implemented locally; local independent repo, transferred plans, explicit source provenance.
- Varied native checkout comparison (2026-10-13): all 27 assignments/108 actors
  completed on OpenCode DeepSeek V4.1 Flash. Current rules produced 3/9 correct
  missions, blocks 1/9, graph 2/9; graph used 73 native turns versus current 36,
  with higher settlement median and reported cost. All final trees preserved public
  legacy behavior; all cohorts stopped. A pre-admission setup interruption remains
  separate, with the original 15 completed outcomes fixed and only the remaining
  12 continued. All 44 original snapshots and 45 continuation/runtime hashes verified;
  879/879 deterministic tests passed before continuation. No overall benefit or RT
  qualification follows. See [varied results and limits](checkout-varied-results.md)
  and [protocol](checkout-varied-protocol.md). Native policy trials reproduce completed
  consumers becoming stale after later provider changes. The next proposed mechanism
  is versioned validation and dependent-output invalidation/revalidation, informed by
  the [source-control design input](checkout-arbiter-prototype.md#source-control-design-input-2026-10-13),
  with dependency exclusion retained as an experimental policy.
- Checkout expansion increment: candidate-bound, atomic whole-block expansion is
  implemented in the local core, graph wrapper and both scoped runner arms. Additional
  helpers/imports are explicit requests; new provider dependencies gain protection,
  not implicit modification rights. Conflicts retain the original grant; stale bases
  require another edit. Sixteen new model-free regressions and nine new binding cases
  cover this increment. Both retained native helper candidates publish in reconstructed
  API qualification; original native scores remain fixed. The final fresh deterministic
  campaign completed 108/108 with zero apparatus errors: current 30/36, blocks 30/36,
  graph 28/36. All 14 recorded runtime hashes verified. Unknown callbacks and two
  completed-consumer stale-output cases remain; no overall graph advantage or RT change.
  The invalid overlapping-test run and the earlier completed follow-up remain retained.
  See [expansion results and next evaluation work](checkout-expansion-results.md).
- RT-0: in progress; deterministic foundation passes, live stream and initial context projection observed; comparative qualification remains open; native OpenCode observations, current state, truthful join/intention metadata, bounded shadow decisions, two-agent diagnostic probe.
- RT-1: not qualified; real comparative benefit/active steering and user reuse remain separate gates.
- RT-2–RT-6: deferred conditional expansion; no guarded-edit safety or remote multiplayer claim.
- Cloudflare platform: proposed and unscoped by RT; Artifacts spike is complete and its
  failure mode did not fire. Durable-state and claim-record work follow the
  [claim protocol](claim-protocol.md).

## First increment

1. Core deterministic tests run without Stow, OpenCode or provider credentials.
2. Observe declared file paths and native source events continuously, with bounds and unknown coverage.
3. Use the configured OpenCode model in opt-in paired awareness-off/on trials. Keep all assigned outcomes.
4. Score independent behavior checks, event/control opportunities, latency and shadow decisions.
5. Record capabilities and failures; do not promote the result to reliable product benefit.

Optional Jev is a later shadow/paired arm with separately configured service access.
The initial deterministic shadow lane demonstrates state/control mechanics, not Jev quality.

The initial injection contract is in [harness context](harness-context.md).

Current observations are in [CAPABILITIES](CAPABILITIES.md); all assigned diagnostics remain retained.

## Ingress squad increment

User-directed expansion: build an unrelated Canadian history game, Canada: Crossroads,
with five real OpenCode specialists in one shared workspace. Ingress names the crew.
Four builders cover historical presentation, engine, API and interface; a separate
integrator follows independent checks. No file claims or per-change model decisions.

- Sourced twelve historical questions from primary Canadian institutions; immutable
  facts and source links are separate from presentation edits.
- Implemented: squad runtime, sourced game fixture and independent gameplay/HTTP checks.
- Retain all assigned outcomes, context/delivery evidence and pre/final verification.
- Publish a runnable local game artifact and inspect the actual browser gameplay.

This is a larger diagnostic demonstration, not comparative RT-1 qualification.

## Simultaneous squad scale

The user clarified that limiting simultaneous builders defeats this experiment.
Default admission must connect and run the entire declared roster concurrently.
An explicit user-selected concurrency setting can remain an option, but a queued
or batched run does not qualify as simultaneous scale. Record peak live processes,
admitted tasks, overlapping native executions and per-actor timings separately.
Keep finite workspace state capacity visible; reject unsupported rosters before
launch rather than silently delaying builders.

The next live fixture assigns sixteen useful builders to the existing game:
eight core browser components, a live interface builder, server support and six
learning/accessibility features. Everyone shares one workspace and the interface
room. A later integration pass cannot stand in for those concurrent builders.

Retain the first five-agent incomplete build (28/31 independent checks) and the
focused finisher runtime failure (29/31 checks). Neither is a successful scale
demonstration. The 32-participant deterministic load apparatus measures relay and
context costs only; it runs zero live model builders. Provider failures, startup
limits, timeouts and incomplete outputs remain outcomes, not discarded samples.

## Completed live sixteen-builder diagnostic

All sixteen native builders overlapped (native execution peak16), with a separate
integration checkpoint afterward. Final generated game passed58/58 independent
checks. Browser QA initially exposed an undefined timeline variable and DOM mount
errors that the static checks missed; integration repaired them. A fresh preview
passed correct/wrong answers, streak scoring, chapter completion, source feedback,
notebook updates, chapter switching and keyboard answer/restart. Parent copy
corrections clarify zero-point wrong answers and preserve selected-button contrast.

All17 assigned native actors stopped. Eight reported success; nine reached a
deadline, including the integrator. Keep those execution outcomes separate from
output correctness.39 contextual notices were admitted;31 were native-delivered
and8 remained accepted/pending. Initial projection/delivery and uncertain read
bases are retained per actor; provider consumption remains unverified.

The next runtime revision removes affinity-based stale-read suppression: preferred
file focus cannot prove authorship. The all-affinity integrator had received zero
notices, so later changes to an already-read mission file could be missed. The
regression now routes changes to any stale read, including that mission file.
Bounded queue/coalescing remains. Future runs retain32 safe model-step capsules per
actor to distinguish request/body and post-body settlement intervals; this run
cannot retrospectively provide those timings.

The playable artifact is examples/canada-crossroads. Run npm run play. The source
and verification records are ingress-game-provenance.json and
ingress-game-verification.json. Live/deterministic results are separate in
ingress-outcomes.json. Qualification of reliable benefit and larger native
cohorts remains open.

## Native OpenCode integration investigation

[Integration model](opencode-integration.md) records the pinned hook/control contracts,
shared-host design, SDK/fork boundaries and remaining compatibility gates. An opt-in
installed-binary probe passed eight assertions: two overlapping sessions on one host,
native successful reads, updated per-session provider-bound context on continuation,
loopback routing, cleanup and process stop. All seven development attempts are retained.
The production squad still uses its previous process-per-actor adapter; no runtime
migration, compaction/cancellation proof, model adaptation or RT-1 qualification is
implied by this plumbing result.

## Repeated native benchmark pilot

The user requested varied repeated tests measuring completion time, complexity and
instruction following. The frozen [benchmark protocol](benchmark-protocol.md) assigns
six two-agent workloads to awareness-off/on conditions, three repeats each. Retain
all36 cohort outcomes and measure native/plugin delivery separately from artifact
behavior. No held-out RT-1 or cross-harness qualification follows from this pilot.

## 2026-09-29: repeated tuning study

The first awareness pilot was stopped and retained as invalid apparatus evidence: absolute permission resources rejected native location-relative edits. Corrected native loopback preflight verifies actual writes. The new [tuning protocol](benchmark-protocol.md) preassigns144 trials/324 roles across stock baselines, coordinated2/4/8-agent teams, builder-reviewer phases, three models, mixed-model pairs,8KiB context and500ms refresh.161 deterministic package tests pass before admission. Completed results and remaining limitations belong in [benchmark outcomes](benchmark-outcomes.json); do not qualify RT-1 based on small tasks.

The user selected GPT-5 Nano and DeepSeek V4 Flash for additional model comparisons. Both passed native read preflight with primary HTTP200 and confirmed stop. The previous study remains cancelled/retained; version3 starts fresh assignments and keeps Space Bunny as the existing control.166 deterministic checks pass before the revised admission.

Revision4 preserves model-native tool menus, observes bounded patch targets and adds matched stock parallel controls for both requested models.162 cohorts/360 roles are preassigned;178 deterministic tests pass. Native context preflight proves serialized context, successful Nano patch/DeepSeek write and changed bytes; DeepSeek’s omitted trailing newline remains explicit task noncompliance. Earlier Nano menu-filter trials remain separately retained. UI changes are independent of the frozen execution/scoring/report fingerprint scope.

Revision4 completed all162 assignments:91 native completions,71 deadline outcomes,71 correct-completed and113 independently correct final artifacts. All owned processes stopped and15 runtime fingerprints verified. [Results and limits](benchmark-results.md) retain six unqualified comparison rows and every historical attempt. No consistent coordination advantage or RT-1 qualification is established. The refreshed live dashboard passed213 deterministic package tests and browser QA.

The user challenged the90-second deadline and whether the fixtures constitute many-agent missions. Both limitations are explicit in the results: this budget is operational, and two-goal fixtures with expanded4/8-role rosters measure possible oversubscription. Follow-up comparative work needs a substantial shared mission, identical acceptance criteria across solo/stock/Ingress, controlled integration/dependency changes, correctness over time and first-correct versus settlement/cost measurements over predeclared multiple budgets. No follow-up real-model study has been admitted.
