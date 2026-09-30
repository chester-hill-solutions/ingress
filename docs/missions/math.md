# Executable mathematics missions

These missions ask eight simultaneous streams to build reusable exact solvers. Each has a protected public input/output contract, an input-only sample, eight seeded editable modules, and a report integration boundary. File focus communicates dependencies and grants no exclusive ownership.

`mathMissions` exports `exact-circulation` and `exact-reliability`. `verifyMathMission(id, root)` runs trusted parent-side graders through `verifyMission`. Each fixture exposes `reviewInvocation` for an input-only representative report batch, identical across configurations. A human can inspect returned JSON and source without seeing private expected answers.

## Exact resource routing

Streams implement domain validation, exact objective arithmetic, residual arcs, optimization, independent certificate auditing, capacity sensitivity, constructive decomposition, and report integration. Networks admit loops, parallel edges, negative costs/cycles and infeasible balances. Supported inputs have up to 12 vertices and 36 edges, capacities up to eight and signed decimal costs up to 10^18. All eight public exports are batch functions; names and full return schemas are in protected `contracts.md`.

A feasible answer alone is insufficient. The grader independently checks conservation and bounds, exact objective accumulation, reduced-cost inequalities, and primal/dual equality. An infeasible answer requires a positive supply-minus-outgoing-capacity cut. Capacity perturbations are solved independently, and path/cycle witnesses must reconstruct every edge flow and supply/demand balance. These are finite executable mathematical certificates, not a claim that prose establishes a formal theorem.

The trusted oracle exhaustively enumerates bounded integer flows for deterministic held-outs, independently of the submission algorithm. Held-outs include cancelling costs above Number's exact integer range, negative loops and cycles, infeasible bottlenecks, seeded multigraphs, and an eight-vertex routing instance. Ten named criteria cover validation, invalid-domain rejection, arithmetic, residuals, optimization, valid/forged audit cases, sensitivity, decomposition, and reports. Sixteen isolated calls cover valid and malformed batches.

## Exact graph reliability

Streams implement validation, selected-edge connectivity, spanning-tree and edge counts, reliability/influence, cut structure, deletion/contraction, constructive witnesses, and complete reports. Inputs support up to ten vertices and eighteen undirected edges, including loops and parallel edges, with exact rational probabilities whose denominators are at most 10^18.

The grader independently enumerates retained edge subsets to obtain connected-by-size coefficients, tree counts and edge participation. It evaluates exact rational probabilities and forced-edge influences, checks count invariants, validates all bridge/articulation witnesses against the original component count, and checks canonical deletion/contraction graphs. A claimed connected graph must provide a real spanning tree; a disconnected graph must provide its exact components. Nine named criteria use sixteen isolated calls, including invalid-domain/active-edge rejection and an exact deletion/contraction probability identity. Held-outs include singletons, disconnected multigraphs, K4, seeded graphs, and a twelve-edge instance with a large denominator.

## Isolation and interpretation

Only public contracts, sample inputs, the package manifest and throwing module seeds enter the model workspace. Private case generation, answer computation, assertions and certificate checks remain in the trusted parent process. Submitted exports run in the existing bounded child evaluator with read access confined to the submission root, bounded memory/output, a 3.5-second call limit and a 30-second evaluator budget. No provider calls are needed for these tests.

All criteria remain present after failures. The helper intentionally collapses invocation failures into a generic error, so invalid-domain tests prove rejection, not the submitted error's precise class. Output tests do not prove caller-object immutability or internal reuse; those public obligations also deserve source review. Passing the deterministic held-outs establishes their exact executable results, not an exhaustive proof over every supported instance.

The test-only circulation reference uses residual augmentations and negative-cycle cancellation, while its trusted oracle enumerates flows. The graph reference uses disjoint sets while its grader uses independent connectivity traversal. Regressions reject throwing seeds, feasible suboptimal flows, forged certificate acceptance, negative circulations ignored by an optimizer, falsely scaled counts that still satisfy participation invariants, floating-point precision loss, fabricated graph witnesses and protected-contract changes. Reference implementations live exclusively in test source and temporary test submission roots.
