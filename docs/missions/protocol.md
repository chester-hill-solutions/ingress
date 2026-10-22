# Large missions and blind tasting

These nine bounded missions exercise eight substantive streams apiece, with integration dependencies. They are larger than the original two-goal fixtures. Research uses frozen evidence and structured entailment checks; math uses exact oracles and certificate checking; SaaS uses executable workflows, isolation, transactions, replay and rendered output; map and analytics use rendered views and recomputed expectations. [Research](research.md), [math](math.md), and [SaaS](saas.md) describe their public contracts and limits.

Two analytics missions are deliberately a pair. [Signal](../mission-signal.md) is specified down to every
signature and graded on 27 criteria of fidelity; [Signal, underspecified](../mission-design.md) is the same
product with the design left in and six product facts, and is graded by a real browser visiting the
submission's own server, because a design cannot be checked against a contract the submission was handed.
Both have been flown: the first scored 27/27 twice ([results](../mission-analytics-results.md)), the second
12/12 once with the fleet designing a product the brief never described
([results](../mission-design-results.md)). The pair exists because the first flight measured spec fidelity
and could not see design, which was the specifying author's to measure and not the fleet's to demonstrate.

Every contender for a mission receives **the same complete MISSION.md directive and identical seeded files**. A solo builder receives all eight streams, two builders receive four each, four receive two each, and eight receive one each. All actors in a roster start in a single concurrent phase. These are interests and responsibilities, never exclusive file claims. Stock and Ingress rosters of the same size have identical actor assignments and the same model's native file menu. Ingress adds its bounded awareness hook. Harnesses can still overwrite each other; observation is not a write fence.

The full study matrix was **frozen at six missions**: six × two requested models × seven configurations ×
three repeats = **252 allocated cohorts / 1,044 actor assignments**. Configurations are stock solo and matched
stock/Ingress rosters of two, four and eight. The first blind flight uses both models, six missions and the
matched four-builder configurations once: **24 anonymous results / 96 actors**. It is a feasibility and
evaluation pilot, not a repeated estimate of speedup or product benefit. A repeat consumes a new assignment
and label, not a retry of a selected successful output. Source fingerprints, assignment order, seed and
operational budgets are persisted before provider access. The registry has since grown to nine missions; a
study names the missions it selects (`--missions=`), so an addition to the registry does not disturb a matrix
that was pre-registered without it.

```sh
npm run missions:plan
npm run missions:real -- --missions=signal-open --configs=stock-eight --models=deepseek-v4-flash
npm run missions:plan -- --repeats=3 --configs=stock-solo,stock-two,ingress-two,stock-four,ingress-four,stock-eight,ingress-eight
npm run missions:view -- --evidence=/absolute/path/evidence-private.json --port=65401   # a flight in the air
npm run missions:trace -- --flight=<flight directory>                                  # the live change stream
npm run missions:retain -- --capture=settled                                           # keep workspaces and fence receipts
npm run missions:regrade                                                               # re-grade retained artifacts
npm run missions:summary                                                               # the durable numbers
npm run missions:review -- --directory=<private flight directory>
```

Provider calls require explicit `--real`. The mission runner defaults to a 15-minute operational cap, including setup, with up to six concurrent cohorts. This cap is **not validated as sufficient for these tasks**. Native completion, elapsed working time, independently correct artifacts and incomplete attempts are separate measurements. Milestone observations at 60, 180 and 600 seconds grade bounded immutable copies without feeding results back to any agent. A double collection detects ordinary changing files, but is not an atomic filesystem snapshot. Time of first sampled correctness is an observation bound, not exact completion time. Snapshot grading consumes local CPU; concurrent load and verification duration are recorded. Final grading happens after native processes settle. Missed, unstable and unavailable observations remain explicit.

A flight also **keeps what it did**, not only what it scored: `missions:retain` copies each cohort workspace and its fence receipts into the flight directory, labelled with how the capture happened, and `missions:regrade` re-grades a retained artifact when a judge defect is found later, refusing when the mission fixture has moved since the flight was graded against it. A mission fixture is frozen once flown, and a test pins the seed hash it was graded against — editing the seed after the fact makes every artifact ungradable rather than re-gradable. `missions:summary` writes a few kilobytes of committed numbers at settle, because the flight directory is a working copy and one of them disappeared.

The independent grader imports submission exports in a separate restricted Node process. Only public test inputs enter that process; assertions and expected answers stay in the parent. It permits workspace reads, blocks filesystem writes, network and process creation, caps files/JSON/output/memory/invocations, and kills timed-out children. **Executable mission grading requires Node 26's network permission support.** This is a Node permission boundary, not a general adversarial operating-system sandbox. Reference implementations occur only in deterministic tests, never seeded into a model workspace. **One mission is graded differently**: `signal-open` ships a problem instead of a contract, so no signature can be checked, and its judge instead starts the submission's server with the permission model bounded to its own workspace plus the network it needs to listen, and drives a real Chrome over the DevTools protocol through a scripted visit. That is a weaker isolation than the function-invocation boundary above, and it is recorded as such; a machine without a browser records `evaluator_refused_browser_unavailable` rather than crediting or blaming the submission. Protected inputs and the complete directive are checked byte-for-byte. Model tasks have native file tools but cannot run shell commands or install packages; this limitation applies to both treatments.

Automatic criteria establish the tested calculation, citation-support or software behaviors. They do not certify all unseen cases, prose quality, general security, production readiness, or formal theorem proofs. Lexical complexity indicators are descriptive. Closed native step token/cost observations exclude unreported interrupted work, reasoning/cache detail and building this experiment; they are not billing reconciliations.

## Blind human judgment

Each assigned contender has a random opaque sample label, independently shuffled display order, and the same directive fingerprint as its comparators. The loopback review server publishes only the mission, directive and submitted outputs while blind. It withholds provider/model identity, team configuration, raw trial/session/workspace identifiers, objective scores, completion outcome, time, spend and complexity. Every allocated attempt appears, including failed admission, missing output and a never-started attempt after cancellation; none are silently selected away.

Rate usefulness, completeness, clarity, coherence and overall quality from 1–5, with optional notes, or explicitly mark a result unevaluable. Saving a rating does not reveal its maker. The separate **Reveal this sample** action is blocked until a rating has been saved. Revealing freezes that sample's rating. For a fully blind flight, rate all samples before revealing any; sequential reveals can make later guesses easier. Human ratings persist independently of ongoing trial publication and remain separate from automatic scores.

Generated code/Markdown is displayed as text. A SaaS demonstration is invoked against one public representative input, identically across configurations; JSON and its rendered HTML are available. HTML previews use an empty iframe sandbox and a restrictive network-disabled content policy; no submission scripts execute in the review app. Recognized model/configuration names in submitted artifacts are redacted in the display, with visible redaction counts; original bytes and hashes are retained privately. This is voluntary authorship blinding, not a guarantee against arbitrary self-identifying prose or inference from writing style. No private mapping route exists before the rating/reveal gate. Provider context and generated prose are ignored artifacts and must not be committed.
