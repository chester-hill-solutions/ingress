# Evaluating whether agents work better together

**Date:** 2026-09-29. **Status:** proposed evaluation protocol, not executed.
Supports [the product plan](realtime-multiplayer-plan.md). The current prototype
is a delivery demonstration, not comparative evidence of reduced coordination burden.

## Claim and limits

Test whether shared awareness improves correct completion of overlapping work while
reducing incompatible edits, duplicated effort and human intervention. Separate that
behavioral claim from reliable infrastructure and from broad product demand.

Infrastructure tests can reproduce exact event schedules. Real model runs remain
variable even with fixed fixtures and recorded seeds. Repeated controlled trials can
estimate performance on the tested tasks; they cannot guarantee arbitrary cooperation.

## Comparison conditions

Run each fixture from identical clean bytes, fresh agent contexts and the same pinned
harness/model configuration, tool access, time/usage budget and task instructions.
Randomize condition order; pair results by fixture and controlled change schedule.

| Condition | What changes |
| --- | --- |
| Parallel baseline | Two agents can read shared files and reread as they choose; no added presence, intentions or peer/dependency notifications |
| Shared awareness | Same tools and write safeguards, plus presence, intentions and relevant causal change notifications |
| Single-agent reference | One agent completes the same combined outcome under a separately recorded budget; practical alternative, not an equal-compute causal control |

Keep stale-write rejection and generation fencing identical in both parallel conditions.
Count their interventions separately: a refused write establishes a safeguard, not that
awareness helped an agent anticipate a conflict. Later ablations can isolate intentions,
change notifications and dependency awareness rather than attributing every benefit
of the full condition to cursor presence.

Record the capability profile for each comparison. The first native observer comparison
uses the same ordinary filesystem tools in both arms; it cannot promise checked-write
refusal. Guarded-edit comparisons later use the same mediated safeguards in both arms.
Do not compare an unguarded baseline with a guarded treatment and attribute prevention
to awareness. A benefit in either profile does not qualify the other's guarantees.

Optional decision-layer arm: shared awareness plus TypeSafe Jev recommendations
mapped through the same control policy. First label/replay compact fixture states in
observation-only mode; include genuine conflicts, compatible overlap, provisional work,
misleading peer messages and insufficient evidence. Freeze questions/action catalog and
thresholds before held-out evaluation. Score missed conflicts and unnecessary steering,
interruptions or waiting, alongside latency and usage. Then run paired real-agent tasks
with and without the decision layer; offline classification alone does not prove agents
adapt better. Include classifier usage and controller interventions in the total budget.
An incorrect confident decision is still incorrect; a stronger fallback judge is not
assumed to provide independent verification.

Continuous-loop qualification uses the actual native/OTel metadata coverage available
in the selected version, with paired full/delayed/dropped/reordered source schedules.
Exercise weak correlation, old-generation spans, a same-generation human steer while
classification is pending, parser lag, inherited context, stale group readiness, duplicate
causes and a lost control reply/crash. Rich sanitized fixture tracing is diagnostic;
success depending on prompt/range fields unavailable in ordinary use does not qualify.
Initial automatic interruption and new-task admission are disabled in every arm.

Measure source coverage/age, observation-to-decision delay, stale decisions discarded,
classifier usage, unnecessary controls and recovery churn. Separate a missed opportunity
due to late observation from wrong classification, unsuccessful delivery and delivered
instructions ignored. Total deadlines include classifier SDK retries. Shadow decisions
do not establish behavioral benefit; qualified actuation uses the same bounded catalog
and task authority as the awareness-only controller.

Baseline agents remain free to inspect real workspace state; do not make them fail by
forbidding sensible rereads. Give both conditions equally clear initial goals. Awareness
adds observations, not a privileged instruction with the correct repair.

## Fixtures and controlled interventions

Use small executable projects with private independent behavioral checks and several
variants per task family. Both agents receive a real goal and decide how to accomplish it.

1. **Changing dependency contract:** producer changes a money value from dollars to
   integer cents while consumer works on formatting/totals. Verify exact results, rounding,
   error cases and dependent tests. Include changed semantics without a renamed field.
2. **Same-file overlap:** agents change intersecting validation behavior. Verify both
   requested behaviors survive and unrelated human edits remain intact.
3. **Duplicate work:** agents encounter an overlapping subtask. Observe whether stated
   intentions let them divide useful work without abandoning a required outcome.
4. **Irrelevant nearby activity:** change a file/range that does not affect the task.
   Verify no unnecessary model admission and no unrelated adaptation.
5. **Uncertain or misleading explanation:** peer prose differs from actual committed
   changes. Verify code evidence prevails and human direction remains authoritative.
6. **Disagreement and churn:** agents have incompatible intentions or an unanswered
   clarification. Verify bounded exchanges, visible escalation and continued unrelated
   work; count unnecessary waits and repeated replans.
7. **Partial change:** producer updates one file in a multi-file change, then delays or
   exits. Verify consumers distinguish provisional edits from ready state and do not
   treat an old passing check or producer declaration as current correctness.

Use observed tool events as barriers: confirm the consumer read revision R, then apply
the producer/human change before the consumer's next relevant operation. Record whether
an actionable awareness opportunity actually existed. Freeze apparatus eligibility
before condition assignment/admission. After assignment, a missed read, timeout, early
pause or unobservable barrier remains in primary task/cost results and is reported by
arm; coordination itself can change whether the read occurs. Opportunity-qualified
adaptation is a secondary subset, with its denominator shown. A pre-admission setup
failure may be replaced only under a frozen condition-independent policy, with its
count retained. Never use a fixed sleep as proof of overlap.

Vary change timing: before read, after read, during generation and near patch admission.
Seed and record the fixture/event schedule; do not imply a seed fixes provider output.
Use deterministic injected human changes for comparison; separately test actual human UX.

## Evidence and scoring

An independent verifier executes hidden behavioral checks against final artifacts.
Agents do not receive hidden checks or exact repair instructions. Blind semantic
review to the comparison condition where human judgment is required. Preserve sanitized
traces, initial/final bytes, operation IDs, read revisions, dependency assumptions,
message/receipt times, admissions and control generations.

Where harness telemetry is available, correlate OTLP or native session/tool events
with confirmed room operations to explain latency and usage. Keep direct read/edit
barriers and independent checks authoritative; missing or late telemetry cannot be
interpreted as an agent doing nothing. Record coverage/export settings and collector
failures. Use the same instrumentation in both parallel conditions; measure its overhead
and do not enable richer source/prompt capture in just the awareness condition.

Primary results are correct-completion rate and number of standardized human rescue
interventions needed to reach correctness within the budget. Report both; an agent
that avoids conflict by doing nothing fails completion.

Secondary results include stale proposals/rejections, silent lost edits, duplicated
work, time to finish, model usage and coordination context, and time from relevant
change to first verified adaptation. Self-report or an acknowledgment marker alone is
not adaptation: inspect the subsequent read/decision/edit and resulting behavior.

Define rescue actions in advance (for example, one neutral reminder to inspect the
latest dependency, then one explicit conflict explanation). Apply the same escalation
policy to each condition. A verifier failure or expired budget does not silently trigger
an extra prompt in only one arm. Include every assigned run, runner failures/timeouts
and missing observability in the primary denominator; do not select attractive successes.

## Run sequence and decision

First run deterministic actors through each fault schedule to verify the evaluator,
barriers, safeguards and independent checks. This validates the apparatus, not agents.
Then run a small real-model pilot to estimate variability and identify invalid fixtures.
Freeze fixtures, scoring and budgets before comparative qualification. Pilot counts
are diagnostic; choose the qualification sample size from the observed variability
and the minimum improvement that would justify adoption, not a convenient round number.

Publish per-task paired outcomes and uncertainty, including adverse cases and raw
counts. Repeat on unseen fixture variants and at least two qualified harnesses before
claiming cross-harness benefit. A single successful demo proves possibility, not reliability.

Continue investment when repeated tasks achieve correct outcomes with meaningfully
less rescue/duplicated work at acceptable usage and latency. Reconsider the design if
agents repeatedly ignore awareness, notifications create churn, or a single agent is
consistently the better practical choice. Agree the adoption threshold before the
qualification run; do not redefine success after inspecting results.

Record four distinct advancement decisions after the diagnostic pilot and before the
relevant held-out qualification; freeze numerical thresholds and sample sizes there:

| Gate | Evidence / outcome |
| --- | --- |
| Trustworthy observation (RT-0) | Available fields, coverage, freshness, correct reducer/recovery and bounded instrumentation overhead; narrow/stop if native evidence cannot support the proposed actions |
| Useful awareness (RT-1) | Correct completion and reduced rescue/duplicate work at acceptable cost; only then justify broader infrastructure or identify pre-admission prevention as the missing need |
| Incremental Jev benefit | Paired gain over deterministic awareness with the same controls and total budgets; retain routing without Jev if classification adds churn/cost |
| Voluntary reuse | Existing-workspace setup, intervention burden and independent repeat use; lab success alone does not pass adoption |

Human/shared-edit/second-harness expansion follows these gates; it does not gate the
initial one-harness result. Report hardware, export configuration, service/model versions
and workload alongside latency so results remain reproducible within their limits.

Add a small supervised user pilot after lab evidence: a developer brings an existing
workspace and ordinary tasks. Measure joining/setup effort, intervention time and whether
they choose to use the collaboration again. This tests adoption separately from model
behavior. Freeze improvement and overhead thresholds before qualification; accepted-edit
loss is always a correctness failure, and sustained automatic discussion without progress
is a failed collaboration outcome.

## Current readiness

The existing [demo](reference/stow-source-record.md) explicitly supplies the
new data contract in its follow-up prompt and uses exclusive output assignments.
It cannot certify spontaneous adaptation, same-file protection or active-task awareness.
Reuse its real-run lifecycle and independent artifact-checking pattern. RT-0 starts
with native continuous observation, declared dependencies, revisioned state, event
barriers and shadow decisions. RT-1 compares bounded awareness/steering in that native
workflow. This can qualify useful adaptation at the actual supported boundary; it cannot
certify human multiplayer, pre-admission stale-write protection, text convergence or
cross-harness realtime. Those require guarded-edit/mixed-harness RT-2–RT-3 evidence.
Retain diagnostic failures; freeze the protocol before qualification. No comparison
or new realtime capability is implemented by this documentation review.
