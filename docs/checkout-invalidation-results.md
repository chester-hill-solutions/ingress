# Versioned publication evidence and dependent-output invalidation

The mechanism the [source-control design input](checkout-arbiter-prototype.md#source-control-design-input-2026-10-13)
named as the next thing to qualify, built and measured on 2026-10-22.

## The failure it addresses

A consumer finished its work, published, and was admitted. A provider changed
afterwards. The consumer's published bytes were now wrong, and nothing in the
workspace said so. The deterministic campaign measured this as **14 of 108
assignments published-but-wrong**: every arm's `contract-sensitive-read` workload,
where a report format embeds a promotion percentage that a policy module changed
after the report was built.

A publication-time read check cannot catch it. In the forward order the provider
publishes first, so the consumer's declared input has already moved by the time the
consumer commits — a read check *would* refuse that commit, and the product already
makes that check when a participant declares `builtFrom`. In the reverse order the
consumer publishes first and the provider changes afterwards: at the moment the
consumer published, nothing had moved, so no read check can fire. The campaign
contains both orders, and the reverse order is the one that was silently wrong.

## The mechanism

`src/prototypes/checkout/invalidation.mjs`, pure and in-memory. Three rules:

1. At publication, record for each output the version (content hash) of every input
   it was built from, and where that declaration came from.
2. When an input advances to a different version, every output that recorded the
   older version loses its approved status. It becomes `invalidated`.
3. An invalidated output is never silently re-approved. It must be revalidated — the
   checks run again against the current tree — or regenerated — published again from
   a current base. Both are recorded on the output's history.

Two distinctions the implementation keeps apart, because collapsing them would make
the ledger claim more than it knows:

- **Approved** means the output was validated and no known input of it has moved.
- **Approved without evidence** means no input of it was recorded at all. The
  workspace reports those separately (`coverage: 'none'`), because "no stale input"
  and "no known input" are different facts and only one of them is a reason to
  trust an output.

## How it was measured

A paired campaign: the same 108 assignments the retained comparison used, run
twice — once with the mechanism off, once with it on — in one run over one
implementation snapshot, so the two conditions are paired rather than compared
across runs. 216 assignments, three arms (current rules, block scopes, graph
scopes), the frozen workloads and schedules, the frozen held checker, no model
calls.

The factor sits **above** each arm. It does not change what an arm admits: it
records what each publication was built from and reports the outputs whose inputs
have moved. The off condition reproduces the retained comparison's numbers, which
is the apparatus check that the harness change did not quietly alter the baseline.

The run happened in a Cloudflare container (`standard-2`: one vCPU, Node 26.3.1, the
same producer packages), not on a workstation, so the measured local costs are a
container's costs and the wall clock is a container's clock. The virtual ticks are
unaffected — they are synthetic by construction — and the correctness numbers do not
depend on the host at all.

### The evidence, and why it is not the graph

The dependency relation the mechanism needs is **not** in the code graph. The
failing case is a consumer that reads a policy value out of another module
*without importing it*; there is no import edge to find, and the relation is
exactly what invalidation compares. The evidence that works is the participant's
own declared inputs, which the product already carries as `builtFrom`, plus
explicit contract records.

In the campaign the declaration is **derived, not asserted**: the patch function
itself reports the paths it read or newly imported, so a task cannot claim a
dependency it did not take and cannot hide one it did. A mechanism that accepted
only graph edges would not have fired once in the whole campaign.

### The recovery policy, stated before the run

An invalidated output's owner regenerates it: it takes a fresh checkout, re-derives
its edit from a current base, and publishes again. Two regenerations per task is
the ceiling; a third is recorded as `invalidation_budget_exhausted` rather than
retried forever.

**This is a model of a worker, not a measurement of one.** The frozen task's
transformation is not idempotent: re-applying it to the file that already carries
its previous output would insert a second copy of the inserted line and leave the
stale one winning. The regeneration therefore re-derives the task's edit against
the version of its own file the worker first started from, with the current values
of the inputs it reads — which is what a worker that *rewrites* its change would
produce. A real worker that appends instead of rewriting would not recover, and
the campaign would report the mission as still wrong.

Revalidation is a different power and is not interchangeable with regeneration.
The workspace's checks are not the mission's checks: re-running them can restore a
status without restoring correctness. That limit is asserted in the mechanism's own
tests, not only described here.

## What the campaign measured

216 assignments, all completed, no apparatus failures, no model calls. The `off`
condition reproduces the retained comparison's numbers exactly — current 30/36,
blocks 30/36, graph 28/36 — which is the check that the harness change did not
quietly alter the baseline.

| Arm | Condition | Correct | Published but wrong | Refused | Invalidations | Regenerations | Of those, output changed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| current | off | 30/36 | 6 | 0 | 0 | 0 | 0 |
| current | **on** | **36/36** | **0** | 0 | 12 | 12 | 6 |
| blocks | off | 30/36 | 6 | 0 | 0 | 0 | 0 |
| blocks | **on** | **36/36** | **0** | 0 | 8 | 8 | 6 |
| graph | off | 28/36 | 2 | 6 | 0 | 0 | 0 |
| graph | **on** | **30/36** | **0** | 6 | 2 | 2 | 2 |

Every wrong outcome in the `off` condition was the `contract-sensitive-read`
workload: all six assignments in the current and blocks arms, and the two reverse-order
assignments in the graph arm. With the mechanism on, none of them is wrong.

**The cost is real and it is visible in the same table.**

- **Half the invalidations changed nothing.** In the current arm, 12 invalidations
  produced 12 regenerations, and only 6 of them produced different bytes. The other 6
  are the `new-dependency` workload: that consumer genuinely depends on a module the
  provider changed, but its own output does not depend on *how* it changed, so the
  regeneration reproduced the same bytes. The mechanism cannot tell those apart from
  the useful ones, and the price is a wasted cycle each time.
- **The graph arm's refusals are untouched.** Its 6 `unresolved_dependency` refusals
  are the conservative unknown-callback cases, and they are the same 6 with the
  mechanism on. Invalidation does not rescue an output the scope mechanism would not
  admit.
- **No extra waiting, no extra cost in the arms that did not need it.** Waiting ticks
  are identical between conditions; the mechanism's cost is regeneration work
  (120 virtual ticks across the current arm, 80 across blocks, 20 across graph), not
  contention.
- **The median time to first correct does not move** (10 ticks for current and
  blocks, 20 for graph) because the recovery happens after the mission was already
  correct in the affected order.

**What this does not show.** The mechanism fixes the failure it was built for, in
the arms where that failure exists. It does not make the graph arm's scope
mechanism better, and it does not make any arm faster — the current arm was already
the strongest of the three at 30/36, and it is now perfect *on these six
workloads*, which is not a claim about repositories.

## What it does not establish

- **No durable form.** The record is in-memory. The product's ledger does not carry
  publication evidence, no route reports an invalidated output, and no admission
  rule consults one. This is the experiment scope, not the deployed surface.
- **No trust model change.** The workspace records the participant's declaration and
  cannot verify that the published bytes were derived from the inputs it declares.
  A participant that re-sends stale work with a fresh declaration clears the
  invalidation. That is the same trust the product already places in a declared
  `builtFrom`, and it is why an invalidation is a status and not a guarantee.
- **Over-invalidation is real and is not solved.** A provider change invalidates
  every recorded dependent, including the ones the change could not have affected.
  The campaign measures how often that happened and what it cost.
- **Not an agent measurement.** Every task in the campaign is a scripted edit. No
  model ran, no agent behaviour was observed, and the recovery policy is a stated
  model. The varied native study that found the original failure
  ([results](checkout-varied-results.md)) remains the only live observation of it.
- **No RT status change, and no qualification.** The comparison arm that this
  mechanism improves is not the arm with an advantage; the arms that publish fewer
  correct missions are the ones that get the mechanism's help here.

## Reproduce

The campaign needs the isolated producer (`tree-sitter`, `tree-sitter-javascript`)
and the lab corpus. It runs no model.

```sh
npm run checkout:compare -- --python=/path/to/isolated/python \
  --repo=/path/to/checkout-arbiter-lab --output=artifacts/checkout-invalidation-comparison-v1
```

The mechanism's own tests need only Node:

```sh
node --test test/checkout-invalidation.test.mjs test/checkout-invalidation-replay.test.mjs
```

The retained run is `artifacts/checkout-invalidation-comparison-v1`: `protocol.json`
(the predeclared assignments and the implementation hashes they were run against),
`results.json` (every assigned outcome), `summary.json`, the per-assignment
`trials/`, and `container-run.log` (the environment the run actually had). The
implementation hashes in the protocol match the committed files exactly, so the run
is reproducible from this tree.
