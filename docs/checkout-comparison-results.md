# Checkout comparison results

At the original checkpoint, the graph-backed prototype was **not an overall improvement on this deterministic
campaign**. It prevented some stale-read work, but excluded more valid mission work than
it recovered. This is a mechanism result, not a live-agent productivity finding.
The subsequent [grant expansion follow-up](checkout-expansion-results.md) keeps these
historical scores fixed and reports the revised prototype separately.

[Protocol](checkout-comparison-protocol.md) version 1 preassigned 108 trials: six workloads,
three acquisition/publication schedules, three arms and two repeats. All 108 completed;
zero apparatus failures occurred in the admitted run. Every outcome, transition, source,
AST and independent execution log is retained in `artifacts/checkout-comparison-v3`.
Initial/producer/checker implementation fingerprints were intact after completion.

| Arm | Correct missions | All tasks published, mission wrong | Synthetic waiting ticks | Rejected work ticks |
| --- | ---: | ---: | ---: | ---: |
| Current product rules | 30/36 (83.3%) | 6 | 0 | 80 |
| Block scopes | 24/36 (66.7%) | 6 | 60 | 60 |
| Block scopes plus graph/contracts | 22/36 (61.1%) | 2 | 120 | 60 |

All arms completed every independent same-file, shared-utility-reader and overlapping
function task pair: 6/6 per workload. Blocks eliminated the current arm's rejected work
on independently edited same-file functions under the contended-first schedule.
They serialized overlapping function edits, replacing rejected work with grant waiting.
The current baseline preserved actual contended starts and current three-way merging;
it was not replaced with a strict file-lock baseline.

The dependency-sensitive workload changed an offer policy and added an offer report.
The report builder chose its value from the exact checkout it received. Current/block
arms always handed it the old policy and produced a wrong final report: 0/6 correct.
Graph protection deferred the report when the provider acquired first, so it read the
new value: 4/6 correct. When the report acquired first, it completed before the provider
changed the policy and the final report became stale: 2/6 still wrong. Protecting active
checkouts does not repair already-published consumers after a later dependency change.
The baseline validator protected existing behavior but did not certify the still-incomplete
new mission; the held mission checker exposed this final inconsistency in every arm.

Both scoped arms failed all six valid new-import missions. Block grants rejected the
import outside the original function range. Graph grants detected the new dependency
and required scope expansion, which the prototype does not implement. These are
completion failures, even though the refusal behavior is correctly enforced.

The graph arm additionally failed all six callback-enhancement missions because the
callback's target remained unresolved. The existing independent callback behavior test
and new mission checker passed the reference and both other arms. This is unnecessary
exclusion for the tested invocation; it does not establish that all arbitrary callback
targets would be safe. Six such requests were refused in this campaign.

These effects give the graph four recovered missions and twelve lost missions relative
to current rules, an overall loss of eight. Relative to block scopes, it recovered four
and lost six, an overall loss of two. Refusing a risky operation and completing a useful
mission are distinct outcomes; reporting refusals as successes would hide this result.

All arms had a median first-correct time of 10 virtual ticks among correct missions;
failed missions remain in the correctness denominator and have no first-correct time.
These ticks are synthetic worker schedules, not elapsed model times. The graph arm's
median total producer/index construction cost was 1,679.8 ms per cohort, including initial
indexing. Median checkout/submission policy time was 2,190.0 ms for graph, 2,292.1 ms for
blocks and 1,132.2 ms for current rules. Those policy measurements include nested
validation and candidate indexing, exclude initial setup, and cannot be summed with
the graph/validator columns. Median existing-behavior validation cost was approximately
1.08–1.13 seconds; median evaluator checking cost was approximately 130–140 ms. These
are unoptimized local Node/Python replay costs, not deployed latency forecasts.

No models ran and no provider credentials were read. Native adaptation, concurrent agent
execution, actual completion/settlement time, model usage/cost and statistical significance
remain unmeasured. Repeats re-executed the same deterministic patches and schedules;
they do not turn eighteen distinct workload/schedule combinations into 36 independent
behavior samples per arm. This is not RT-1 qualification or a held-out generalization claim.

Preflight attempts v1 and v2 remain retained separately. V1 found an ambiguous default
receipt edit anchor. V2 found that the proposed priority enhancement changed an existing
callback's string return contract. Both were apparatus failures before comparative
admission, with all 108 planned assignments retained and zero admitted trials. The anchor
was narrowed and the enhancement made opt-in; the corrected references reject every
seed and pass existing behavior plus all six mission goals before v3 admission.

The next useful engineering work is atomic scope expansion covering module bindings,
a way to qualify or conservatively widen known callback targets, and validation or
invalidation of already-published dependent outputs. A native working-copy/grant bridge
is then needed for the larger configured-model comparison. Its budget choice remains a
separate user decision; existing observer/squad trials do not exercise this checkout path.
The [native readiness and mission proposal](checkout-comparison-protocol.md#real-agent-readiness-and-proposed-mission)
records the conditions for that phase. No deployed product behavior was changed here.

Reproduce with Node 26 and the pinned optional producer environment:

```sh
npm run checkout:compare -- --python=/private/tmp/ingress-graphify-venv/bin/python
```

A fresh ignored output directory is created for every run. The full Node 26 suite
passed **842/842** and repository boundary/link and whitespace checks passed. The test log is
`artifacts/checkout-comparison-node26-tests.tap`; ordinary regressions require only Node.
