# Ingress

A standalone experiment in agents working in one native workspace with shared awareness.
No file claims. Native observations describe activity and changed bytes; they do not
prevent overwrites. Stow checkpointing is an optional later integration.

```sh
npm test
npm run check
npm run demo
npm run probe:real
```

Add `-- --serve` to the probe command to keep the read-only live view open.

The harness supplies task-scoped workspace context with the initial connection,
including existing participants and their last known cursor. Later dependency changes
use the same contextual envelope. See [the harness contract](docs/harness-context.md). Unknown locations and observation gaps stay visible.

The real probe uses a dedicated OpenCode 2.0.16 server and your selected OpenCode model.
It reads the existing provider login only in opt-in real mode, keeps it in memory and
scopes child HOME/XDG state outside the fixture. It creates a temporary fixture and
sanitized evidence; it does not modify user workspaces or global harness settings.

The deterministic demo checks the apparatus. A small real probe is diagnostic, not
proof of reliable collaboration or Jev benefit. See [plan](docs/plan.md).

Node 26+; no runtime packages or Stow checkout required for the initial probe.
Private working repository, Apache-2.0. Source provenance is in
[the transfer record](docs/source-provenance.json).

The separate [checkout arbiter experiment](docs/checkout-arbiter-prototype.md) explores
revision-pinned block grants. Planned v1 uses structural dependency graphs and explicit
contract evidence; the optional embedding trial remains available as a retained experiment:

```sh
npm run checkout:prototype
npm run checkout:evaluate
```

The [comparative replay](docs/checkout-comparison-results.md) completed 108 assignments
and found no overall improvement before grant expansion: current rules completed
30/36 missions, block scopes 24/36 and graph scopes 22/36. Missing scope expansion and
unresolved callback targets prevented valid work. Run it with
`npm run checkout:compare -- --python=/path/to/isolated/python`.

The subsequent [grant expansion increment](docs/checkout-expansion-results.md)
completed a fresh 108-assignment replay: current 30/36, blocks 30/36, graph 28/36.
Explicit expansion recovers new-import work while preserving conflict and validation
checks. Graph still excludes unknown callbacks and has no overall advantage.

The graph-backed lab qualifier has passed all 13 independent checkout scenarios,
15 adversarial binding cases and concurrent same-file publication/outside-scope checks.
The [native DeepSeek V4.1 pilot](docs/checkout-native-results.md) completed nine real
four-agent cohorts: current rules and block checkouts each produced 2/3 correct
missions, graph checkouts 1/3. Graph needed 30 model turns versus 12 for each other
arm. This small pilot establishes no overall improvement. Earlier V4 provider
failures remain retained. `npm run checkout:agents -- --plan --python=/path/to/python`
prepares an assignment manifest without model calls.

The [varied native study](docs/checkout-varied-results.md) completed 27 cohorts across
three workflows: current 3/9 correct missions, blocks 1/9, graph 2/9. Graph used 73
native turns versus current 36, with higher reported cost. All cohorts stopped; a setup
interruption and continuation remain recorded. Completed policy consumers became stale
after later provider changes, making versioned validation and dependent-output
invalidation the next proposed mechanism to qualify. No RT status changes.

Its private copies and publication decisions live in memory; it is not wired into
the deployed product or the observation harness.

The [invalidation increment](docs/checkout-invalidation-results.md) qualifies the
mechanism that study pointed at: at publication the workspace records the version of
every input each output was built from, and an input that advances invalidates the
outputs that depended on it. It was measured as a paired campaign — the same 108
assignments with the mechanism off and on, one run, one implementation — and the
dependency relation it needs turned out not to be in the code graph at all: it is a
data dependency with no import edge, so the evidence has to come from the
participant's own declared inputs. No RT status changes.

The [recovery increment](docs/mission-recovery-results.md) is that mechanism's
product-side form and its first exercise on the deployed surface: the ledger holds the
publication record, `GET /w/:name/invalidated` reports what a write contradicted
including through the transitive closure, and a commit that contradicts an output
retains the event. A mission of three container participants and a moving source was
run twice against the deployment, with the recovery tax measured — container time,
bytes, and how many regenerations produced the bytes already there. The dollars a
model-driven participant would spend are not measured, and the recovery policy is a
stated model of a worker that redoes its own work.

The standalone [checkout lab corpus](fixtures/checkout-lab/README.md) has a working
order/fulfillment application, independent behavior checks, explicit data contracts,
and 13 prospective checkout scenarios. Materialize it outside this repository:

```sh
npm run checkout:lab -- --destination=/absolute/path/checkout-arbiter-lab
```

Run fresh extraction and arbiter qualification on that repository with an isolated
Python containing `graphifyy==0.9.62`, `tree-sitter==0.25.2` and
`tree-sitter-javascript==0.25.0`:

```sh
npm run checkout:qualify -- --python=/path/to/isolated/python --repo=/absolute/path/checkout-arbiter-lab
```

Ordinary `npm test` checks the graph boundary using frozen source-hashed facts and needs
only Node. Dynamic or unresolved call targets are conservatively refused; durable,
authenticated checkout integration remains open.

Ingress dispatches a declared OpenCode squad into one shared project and can assign
an integration agent after independent prechecks. The default runs the whole roster
concurrently; an explicit concurrency setting is optional. Live scale experiments
and deterministic relay load tests have separate evidence.

```sh
npm run squad:real -- --serve
npm run play
```

The squad builds **Canada: Crossroads**, a Canadian history map-and-timeline game.
The game artifact lives in `examples/canada-crossroads` after a completed promoted
build (now available locally). Initial context and relevant dependency updates are delivered through the
native harness; preferred file focus creates no ownership claims. All assigned
outcomes and pre/final independent check results remain in local artifacts.

For the sixteen-builder extension experiment on an existing game:

```sh
node scripts/squad.mjs --real --fixture=extensions --root=/absolute/game/path --serve
node scripts/scale.mjs --participants=32 --events=2000
```

The first command runs every assigned builder concurrently by default. The second
runs deterministic participants and zero models; it is a relay/context benchmark.
The generated game passed58 independent checks and a browser play-through. Eight
of seventeen native tasks reported success and nine reached their deadlines; both
execution outcomes and correct outputs are retained. See [the execution record](docs/ingress-outcomes.json).


The repeated native tuning study compares stock OpenCode and Ingress teams across
six fixture families, with solo/pair baselines, four/eight-agent teams, mixed models,
context budgets and refresh rates. See [the protocol](docs/benchmark-protocol.md)
[the results](docs/benchmark-results.md) and [the outcome ledger](docs/benchmark-outcomes.json).

```sh
npm run benchmark:real
node scripts/benchmark-view.mjs --evidence=/absolute/path/evidence.json --port=65392
```

The read-only benchmark dashboard provides live progress, model/configuration
filters and expandable agent rosters. It keeps correct final artifacts, native
completion, instruction checks and observation coverage separate. Missing live
activity stays unknown; filters apply to the bounded comparison/activity views.

## Large missions and blind tasting

Six new missions cover evidence research, exact mathematics, and integrated SaaS workflows, with eight substantive streams each. All contenders for a mission receive identical inputs and the full directive. Matched stock/Ingress rosters can run with two, four or eight builders, plus a stock solo baseline. Anonymous outputs are available for human ratings before explicit authorship reveal. See [the mission protocol](docs/missions/protocol.md).

Executable mission grading requires Node 26, because submission isolation relies on
that runtime's permission model to deny writes, private reads, child processes and
network without trusting the submission. On an older runtime the grader reports
`isolationRefused` and an `evaluator_refused_isolation_unavailable` check rather than
a grade, because an unrunnable grade and a wrong submission must not look alike in
retained evidence.

```sh
npm run missions:plan
npm run missions:real
npm run missions:review -- --directory=<private flight directory>
```
