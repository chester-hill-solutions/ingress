# Repeated native team study results

Completed 2026-09-29 Toronto (2026-09-30 UTC). [Protocol version 4](benchmark-protocol.md).

The study does not demonstrate a consistent coordination advantage. DeepSeek coordinated pairs tied stock pairs on correct completion; Nano coordinated pairs underperformed stock pairs. Larger teams often produced correct artifacts but did not terminate within the declared deadline. These are descriptive observations from small tasks, not a causal product-benefit claim.

All 162 preassigned cohorts were attempted: 91 completed native execution and 71 reached the 90-second deadline. Of all assignments, 71 were correct and completed, and 113 had independently correct final artifacts after writers stopped. There were no failed, cancelled or unrun cohorts. All owned processes stopped; 356 of 360 planned actors were admitted. Four reviewers never entered execution because their builders exhausted the cohort deadline.

All 15 frozen execution/scoring/report fingerprints match the saved source snapshot. Dashboard sources were outside that scope. Historical failed/superseded revisions remain in the [outcome ledger](benchmark-outcomes.json); their rows are not substituted into these results.

The following table uses the same three representative families—shared-features, dependency-refactor and strict-format—at three repeats each. It shows all nine assigned outcomes for each configuration/model group. Correct-completed timing describes only that selected subset; it cannot rank configurations with different failure/deadline rates. Complexity describes independently correct artifacts only, with its measured sample count.

| Model | Configuration | Correct + completed / assigned | Correct artifacts | Deadlines | Correct-completed median (n) | Correct-artifact code lines median (n) |
|---|---|---:|---:|---:|---|---|
| DeepSeek V4 Flash | ingress-pair | 8 / 9 | 8 | 0 | 33.9s (8) | 26 (8) |
| DeepSeek V4 Flash | stock-parallel-pair | 8 / 9 | 8 | 0 | 47.4s (8) | 25.5 (8) |
| DeepSeek V4 Flash | stock-solo | 8 / 9 | 9 | 1 | 27.2s (8) | 30 (9) |
| DeepSeek + Nano | ingress-pair | 4 / 9 | 4 | 0 | 51.7s (4) | 35 (4) |
| GPT-5 Nano | ingress-pair | 4 / 9 | 4 | 0 | 32.9s (4) | 33 (4) |
| GPT-5 Nano | stock-parallel-pair | 7 / 9 | 7 | 0 | 44.8s (7) | 40 (7) |
| GPT-5 Nano | stock-solo | 3 / 9 | 3 | 0 | 32.4s (3) | 42 (3) |
| Space Bunny | builder-reviewer | 1 / 9 | 5 | 8 | 55.3s (1) | 30 (5) |
| Space Bunny | ingress-eight | 0 / 9 | 8 | 9 | Unknown (0) | 33.5 (8) |
| Space Bunny | ingress-four | 1 / 9 | 8 | 8 | 81.1s (1) | 35.5 (8) |
| Space Bunny | ingress-pair | 4 / 9 | 7 | 5 | 66.4s (4) | 30 (7) |
| Space Bunny | ingress-pair-slow-updates | 5 / 9 | 6 | 4 | 85.3s (5) | 26 (6) |
| Space Bunny | ingress-pair-small-context | 4 / 9 | 6 | 5 | 55.2s (4) | 19 (6) |
| Space Bunny | stock-parallel-pair | 3 / 9 | 5 | 6 | 62.5s (3) | 34 (5) |
| Space Bunny | stock-solo | 5 / 9 | 6 | 4 | 49.7s (5) | 61.5 (6) |

## Matched stock-pair comparisons

Pairs require the same fixture, repeat, model set, seed and complete work goal. Results retain unsuccessful and deadline outcomes. Coverage-qualified results are shown separately, because excluding malformed calls or non-admitted roles can introduce selection bias. Mixed-model teams have no matching mixed stock control and remain unpaired.

| Model | Matched pairs | Treated wins / stock wins / ties on correct completion | Qualified pairs: wins / losses / ties | Completed-pair timing difference, treated minus stock |
|---|---:|---|---|---|
| GPT-5 Nano | 9 | 0 / 3 / 6 | 8: 0 / 2 / 6 | -6.5s median, n=9 |
| Space Bunny | 18 | 6 / 4 / 8 | 18: 6 / 4 / 8 | +16.4s median, n=1 |
| DeepSeek V4 Flash | 9 | 1 / 1 / 7 | 9: 1 / 1 / 7 | -2.4s median, n=9 |

Space Bunny comparisons above include all six families (18 matched pairs); requested-model comparisons include three families (nine pairs each). Seventeen Space Bunny pairs contained a deadline, leaving only one pair with measured native completion on both sides. The Nano/DeepSeek timing medians include incorrect completed outputs and are not successful-task speedups.

Every four/eight-agent trial recorded the full native execution peak of four/eight, with the full roster admitted. Four-agent teams completed correctly once out of nine; eight-agent teams never completed within the deadline. Both sizes had eight correct final artifacts. These tasks began with two original functional goals, so the larger rosters may be oversubscribed. Twelve independent cohorts shared provider/host load; the study does not isolate scaling or provider contention.

## Instruction evidence and uncertainty

The dashboard separates 655 passed scope checks and two unknown target checks (657 total), 162 passed observed tool-obedience checks, and 559 passed / 98 failed required-behavior checks. Scope observations do not prove a general sandbox guarantee. The conservative runner grade retains unknown write targets as failed acceptance checks; the dashboard labels their uncertainty explicitly rather than claiming a proven protected-file violation.

156 cohorts have qualified comparison evidence. Four builder-reviewer cohorts lack whole-team exposure because reviewers were never admitted. Two Nano cohorts include failed native patch calls whose targets could not be extracted; those independently failed functional checks as well. All original rows remain present. Verified context serialization establishes exposure, not behavioral adaptation.

## Interpretation and artifacts

Lexical JavaScript code lines, branches, functions and depth are descriptors, not maintainability or quality scores. Compare within the same fixture and retain correct-artifact sample counts; different successful subsets make pooled medians selective. No time-to-first-correct measurement is available, so an artifact checked after a deadline cannot be treated as timely completion. Native token/cost fields remain unknown where the harness did not supply them.

The 16-minute study ran with GPT-5 Nano and DeepSeek V4 Flash as requested additional models and Space Bunny as the original control. Provider temperatures/traffic were not experimentally controlled. Three repeats and small fixtures cannot qualify RT-1, reliable clash avoidance, active steering, or cross-harness portability.

Local retained evidence: `artifacts/benchmark-8c51e44c-bb2f-4e89-b076-d654ce9d0973/` contains `evidence.json`, the full per-fixture `report.md`, metadata-only `analysis.json`, frozen `protocol.md`, and exact `source-snapshot/`. Generated artifacts remain ignored. The read-only live view is at `http://127.0.0.1:65392/` while its local server runs.

Dashboard validation: 213 deterministic package tests passed, repository/link checks passed, desktop filters/disclosures/live updates and a 390px layout were verified. SSE backpressure now waits for drain and coalesces to the latest snapshot instead of disconnecting healthy clients on a large update. No benchmark execution/scoring source changed during dashboard work.

## Reported token and cost observations

The final 162-cohort run recorded 1,867 closed native model steps across all 356 admitted actors. Those steps reported 8,090,086 input tokens, 766,363 output tokens and total cost 0.409049804 (about USD0.41 in native provider cost units). Every observed closed step had these three numeric fields; the four non-admitted reviewers had no step/usage observation. These are native field sums, not complete billed-token accounting. Cache and reasoning breakdowns were not retained by the benchmark normalization. Interrupted/in-progress work can incur unreported charges. Superseded runs, preflights, other provider traffic and Codex dashboard builders are outside this total. Space Bunny reported zero cost, which does not imply zero token/resource use.

Each requested-model pair configuration below attempted the same three families at three repeats, with two concurrent roles per task. Counts include incorrect results. Differences are observed total input, not an isolated estimate of injection overhead; turn count and model behavior can also change.

| Model | Configuration | Reported input | Reported output | Closed steps | Reported cost | Correct + completed |
|---|---|---:|---:|---:|---:|---:|
| gpt-5-nano | stock-parallel-pair | 98,405 | 28,776 | 121 | $0.0368 | 7 / 9 |
| deepseek-v4-flash | stock-parallel-pair | 81,205 | 122,145 | 93 | $0.0582 | 8 / 9 |
| gpt-5-nano | ingress-pair | 289,420 | 26,515 | 92 | $0.0428 | 4 / 9 |
| deepseek-v4-flash | ingress-pair | 601,396 | 104,135 | 97 | $0.1159 | 8 / 9 |

Nano Ingress pairs used about 2.9 times the reported input of stock pairs; DeepSeek pairs used about 7.4 times. Reported cost increased about 16% and 99%, respectively. No token-efficiency benefit is established. The measured configuration refreshes a bounded whole-context envelope at model-request boundaries. Stable initial context, compact subsequent changes, relevant peer details and actual cache/reasoning accounting are refinement candidates, not changes to this frozen run.

Stow storage operations themselves call no model. Its local [checkpoint profile](https://github.com/chester-hill-solutions/stow-s3/blob/main/docs/plan.md) measured 129 ms median for 256 files / 8 MiB and 1.74 s for 4,096 files / 64 MiB across five captures, with an 11.10 s first capture for the larger fixture. Those timings describe storage, separately from model/token spend; full-copy retention remains proportional to payload per checkpoint.

## Workload and deadline qualification

The 90-second deadline was a predeclared operational budget, not a validated adequate completion window. Predeclaration supports reproducibility but does not establish eventual completion time or inability to finish. The eight-agent result means no team settled within this budget; eight correct artifacts out of nine make the distinction material.

These are small apparatus fixtures with two original functional goals, not projects with eight substantial workstreams. Expanding roles across validation and integration concerns can oversubscribe a small mission. The run verifies concurrent machinery and measures observed overhead; it is weak evidence for the value of many-agent teams on many-agent work.

The next workload should have independent substantial components, shared interfaces and integration dependencies, plus a controlled requirement/dependency change. All configurations must receive the same overall mission and acceptance criteria. Measure time to first independently verified correct immutable snapshot separately from native team settlement, correctness over time and reported token/cost to each milestone. Use several predeclared budgets (e.g. 1/3/10 minutes), maintain censored observations and isolate workload/provider contention before general speed or efficiency claims. This follow-up is proposed; no new model run has started.
