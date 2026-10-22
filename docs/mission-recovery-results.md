# Publication evidence on the deployed product, and the recovery tax

Completed 2026-10-22. The [invalidation campaign](checkout-invalidation-results.md) qualified
the mechanism in a deterministic replay; this is its product-side form, deployed, and the
first exercise of it on the deployed surface — where the participant is a container command
that declares its own provenance and the fence arbitrates what lands.

## What was built

| Where | What |
| --- | --- |
| `src/product/invalidation.mjs` | The pure derivation: the invalidated set from the ledger's own file revisions, with transitive closure |
| `src/product/fence.mjs` | `evidence` on the file record, and `refreshEvidence` for re-affirmations |
| `src/product/commit.mjs` | Records the publication record at the moment of publication; retains `output_invalidated` and `evidence_refreshed` receipts |
| `GET /w/:name/invalidated` | The authenticated read route, derived on every call |
| `fixtures/mission-recovery.mjs` | The mission: three generating participants and a source that moves |
| `src/mission-recovery.mjs` | The recovery policy and the tax arithmetic |
| `scripts/mission-recovery.mjs` | The driver: real containers, two rounds, `npm run missions:recovery` |

Deployed to `ingress-workspace` as version `8208299a`. Nothing else about the product
changed: no admission rule consults the status, no reader is blocked, and nothing re-runs a
participant by itself. The deployment is how two defects were found that no unit test had
reached — see [the two findings](#the-two-findings-only-a-live-run-could-produce).

## The mission

Three participants build a small project in real containers, each declaring at publication
the revision of every input it was handed. The declaration travels in
`.ingress/built-from.json`, which the launcher already attached to the manifest and which the
reporter never commits, so it is a claim about the work rather than a change to it.

```
config/policy.json   the source, declared built from nothing so it can never be invalidated
src/report.mjs       generated from the policy — its value changes when the policy does
src/summary.mjs      generated from the report — the transitive case, two hops from the source
src/notes.mjs        generated from the policy, and its value does not depend on the offer
```

A fourth participant moves the source. Twice. The second round exists because one round is a
demonstration and the second is the one that shows the loop is a loop: the recovery wave's own
publications become the evidence the next round contradicts.

## What the deployed product did

`recovery-1792684329636`, version `8208299a`, 11 container starts, 42/42 checks.

| | Round 1 (offer 10 → 20) | Round 2 (offer 20 → 30) |
| --- | --- | --- |
| Invalidated after the move | 3: `src/report.mjs` depth 0, `src/notes.mjs` depth 0, `src/summary.mjs` depth 1 via `src/report.mjs` | the same three, one revision later |
| Evidence on the direct entries | `config/policy.json` 1 → 2, author `policy-1` | `config/policy.json` 2 → 3, author `policy-2` |
| Asked to regenerate | `notes` (attempt 1), `report` (attempt 1), `summary` (attempt 1) | `notes` (attempt 2), `report` (attempt 2), `summary` (attempt 2) |
| Invalidated after recovery | 0 | 0 |

Both rounds end **coherent** (nothing the workspace knows about is invalidated) and
**correct** (every output holds the value the mission asked for — `offer = 30`,
`total = 30`). The transitive entry carries `via: ["src/report.mjs"]` and no stale input of
its own, which is the distinction the report exists to make: `src/summary.mjs` was not built
from anything that moved; it was built from something that stopped being approved.

The uncovered set is reported rather than approved: `PRODUCT.md` and the five `tools/*.mjs`
are bootstrap content with no declaration, and they stay uncovered across both rounds. The
source `config/policy.json` leaves the uncovered set when the policy participant declares it
built from nothing.

## The tax

Six regenerations over two rounds, measured against the content hash each output held
immediately before the recovery wave:

| Output | Regenerations | Bytes changed | Container time |
| --- | ---: | ---: | ---: |
| `src/report.mjs` | 2 | 2 | 16.1 s |
| `src/summary.mjs` | 2 | 2 | 16.7 s |
| `src/notes.mjs` | 2 | **0** | 15.6 s |
| **Total** | **6** | 4 | 48.3 s |

Across the whole mission: 11 container starts, 84.6 s of container wall time (measured by the
harness around each `/start`, so it includes container boot), 235 bytes committed.

**One regeneration in three changed nothing**, and it is the same output both times. That is
the over-invalidation the campaign predicted, now measured on the deployed surface: the notes
output genuinely depends on the source — it declares it, and the fence holds it to that — and
its value does not depend on the offer, so redoing the work produces the bytes that were
already there. The mechanism cannot tell the two apart, and the tax is one wasted regeneration
per change to the source, per dependent that does not use the value.

**No dollars.** No model ran, so the model-cost totals are zero rather than absent, and they
are reported separately from container time. Nothing here converts a token into a dollar.


## The two findings only a live run could produce

The mission was run three times against the deployment. The first two failed, and **both
failures were the mechanism's, not the harness's** — each one a state the unit tests could not
reach because nothing in them had a container's shape.

### 1. An output whose value does not change could never be cleared

One check — *nothing is invalidated once the owners have republished* — failed on both rounds.
`src/notes.mjs` depends on the policy and does not use its value, so redoing the work produces
the same bytes. Identical bytes are `no_change`: `evaluateCommit` refuses to churn a revision
for them, `applyCommit` skips them, and the file record keeps the evidence it was published
with — which is now contradicted. Its owner could regenerate as often as it liked and the
workspace would still report it stale. The only way out would have been to perturb the output
so the bytes differed, which is absurd.

The fix rests on a distinction the first version had collapsed: **a revision and a claim are
different things.** Identical bytes must not consume a revision — that is why `no_change`
exists. But identical bytes *can* be re-derived against current inputs, and that re-derivation
is exactly the evidence the record needs. So `refreshEvidence` moves the claim and not the
bytes, `evidenceRefreshedAtSequence` records that the claim is newer than the bytes, and a
later write drops both because a write is a new publication rather than a re-affirmation.

### 2. A participant holding somebody else's file could overwrite its evidence

The second run failed differently and worse: the workspace reported **nothing** invalidated
after the source moved, and every file's evidence — including `PRODUCT.md` and the bootstrap
tools — cited `src/report.mjs`. The mechanism appeared to work while doing nothing at all.

The cause was the fix for the first finding. A participant's container is seeded with
everything it declared it depends on, and the launcher commits the **whole tree**, so the
summary participant re-sends the report it reads on every commit. The re-affirmation path
asked `evidenceForCommit` for evidence, and that function falls back to the participant-wide
dependency list when a file declares nothing — which is right for a *publication*, where the
file is one the participant produced and the fence already held the commit to that list. For a
*re-affirmation* it is wrong: the summary's dependency list is `src/report.mjs`, so it stamped
`src/report.mjs@1` onto the report, replacing the report's real evidence — built from the
policy. Nothing then cited the policy, so nothing was invalidated when the policy moved.

So a re-affirmation now requires an **explicit per-file declaration**, and a file the manifest
says nothing about is left exactly as it was. Both findings are held by tests: the first by the
re-affirmation tests, the second by one named for the shape it protects — *a participant
holding somebody else's file cannot re-affirm it* — and by a mutation that reintroduces the
fallback.

Two further properties are asserted rather than assumed, and both fail closed:

- An unchanged file never reaches the fence's staleness check, because `no_change`
  short-circuits before it. The declaration is checked before it is recorded instead. A
  participant that re-sends an unchanged output still declaring the revision that moved gets
  the output left contradicted, and is told why through `unrefreshed` — a silent refusal to
  record a claim reads exactly like a claim that was recorded.
- A re-affirmation identical to the record is not re-receipted. A whole-tree commit re-sends
  every file a participant holds, and a receipt per output per commit is noise the audit trail
  pays for.

**What neither fix establishes** is that the work was redone. The record says the participant
declared this output against current inputs, and the workspace can check that the declared
inputs are current. It cannot check that the participant looked at them. That is the same trust
the whole declaration-based relation rests on, which is why the receipt names the participant
and the revision rather than asserting anything about the work.


## The tax

<!--TAX-->

## What it does not establish

- **No dollars.** Every participant is a deterministic command, so the tax is container time,
  bytes and starts. `src/mission-recovery.mjs` keeps model cost and container time in separate
  totals and adds nothing across them, because a harness that converts a token into a dollar
  can make any mechanism look affordable. The model-cost half needs model-driven participants
  and is not measured here.
- **Not an agent measurement.** The recovery policy is a *stated* model of a worker that redoes
  its own work when told its output is stale. Whether a model would, and what it would cost, is
  the open question this run does not answer.
- **No admission change.** The status does not block a read, does not block a write, and does
  not gate anything. A participant that never looks at `/invalidated` is unaffected.
- **One mission, one shape.** Three outputs, one source, one transitive hop. The campaign's
  six-workload replay is the wider evidence; this is the first evidence that the mechanism
  survives contact with containers, leases and the fence.
- **No RT status change, and no qualification.** Nothing here advances a trial status or
  establishes useful benefit.

## Reproduce

The live run boots real containers on the account and is opt-in by credential:

```sh
INGRESS_WORKSPACE_TOKEN=... npm run missions:recovery
```

The parts that need neither the account nor a container:

```sh
node --test test/product-invalidation.test.mjs test/mutations/invalidation-mutations.test.mjs
node --test test/mission-recovery.test.mjs test/mission-recovery-mission.test.mjs
```

## Retained runs

All five are on disk under `artifacts/`; nothing was discarded, including the failures. Each
directory holds the mission, both rounds, the invalidated sets, the plans, the tax and the
verdict.

| Run | Version | Starts | Coherent | Correct | What it shows |
| --- | --- | ---: | --- | --- | --- |
| `mission-recovery-1e070be3` | `487c1c05` | 7 | no | yes | The stuck invalidation: the unchanged output could not be cleared |
| `mission-recovery-7f9e9de7` | `af90c208` | 3 | yes | **no** | The clobbered evidence: nothing cited the source, so nothing was invalidated and the mission stayed at `offer = 10` |
| `mission-recovery-9d3b9125` | `8208299a` | 63 | yes | yes | The product is correct; the *harness* counted every file in the whole-tree commit as a regeneration |
| `mission-recovery-56897c44` | `8208299a` | 11 | yes | yes | The accounting fixed; one assertion was still written for a single round |
| `mission-recovery-05b484af` | `8208299a` | 11 | yes | yes | The run reported above, 42/42 |

The last two differ only in the harness, which is why the harness's own arithmetic is
asserted against the run it measured: `tax.totals.starts` must equal the number of `/start`
calls the driver actually made. A tax that disagrees with the run is a tax nobody should
believe.

