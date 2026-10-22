# State of play

Written 2026-10-22, at the end of a day that moved this from a proposal to a measured system. What
exists, what it proves, and what it does not.

## The pitch

A harness for putting a **fleet of cheap models on one piece of real work**. Agents hold leases on
files; a fence — not a merge conflict — decides what lands; every published output records the
revision of every input it was built from; and when an upstream file moves, the workspace names the
outputs that just became wrong and who is holding them. It drives real OpenCode sessions through the
native plugin, runs the work in real containers, grades the artifacts against contracts the agents
never see, and keeps the trace of what each agent did.

The difference from "several agents editing a repo" is the staleness problem. Over a long horizon the
dominant failure is not that an agent cannot write code — it is that an agent's output was right when
it was written and is wrong now, and nothing notices. This notices, prices the repair, and keeps the
record.

## 1. The product (deployed)

| | |
| --- | --- |
| What | `ingress-workspace`: a Durable Object per workspace that arbitrates leases, commits, content revisions and usage; containers as executors |
| Where | Cloudflare, account `6b149553…` (personal), worker `ingress-workspace` |
| Version | `8208299a` — and the working tree has no changes under `src/product/`, so the deployment *is* the committed product code |
| Credential | rotated 2026-10-22; `x-ingress-workspace-token`, stored 0600 at `~/.config/ingress/workspace-token`. 401 without it, 403 with a wrong one |
| Admission | whole-file leases, per-file `builtFrom` scoping, three-way merge on a moved base, atomic commits through the gate |
| New today | the **publication record**: what each output was built from, where the claim came from, and `GET /w/:name/invalidated` reporting what a write contradicted, including transitive closure, with `output_invalidated` and `evidence_refreshed` receipts |
| Untouched | no admission rule consults the status, no reader is blocked, nothing re-runs a participant by itself |

## 2. The mechanism, measured

| Measurement | Result |
| --- | --- |
| Deterministic campaign (216 assignments, mechanism off vs on, one implementation) | current 30/36 → **36/36**, blocks 30/36 → **36/36**, graph 28/36 → **30/36**. The `off` condition reproduces the retained baseline exactly |
| Its cost | 12 invalidations → 12 regenerations, **6 of which changed nothing** — half the mechanism's work is wasted on dependents the change could not affect |
| Recovery mission on the deployed product (real containers, two rounds) | 3 outputs invalidated per round: two direct, one two hops out at depth 1 with its carrier named; **0 invalidated** after the owners republish. 11 container starts, 84.6 s |
| Its tax | 6 regenerations: 4 changed bytes, 2 produced the bytes already there. **One in three wasted** |
| Defects found only by deploying it | an output whose value does not change could never be cleared (`no_change` skipped the evidence refresh); and the first fix let a participant that merely *held* a seeded file re-affirm it, overwriting the publisher's evidence so nothing was ever invalidated |

## 3. The harness

| | |
| --- | --- |
| Missions | 9 — `synthetic-systematic-review`, `primary-cache-evidence-audit`, `exact-circulation`, `exact-reliability`, `operations-desk`, `reservation-ledger`, `ontario-drive`, `signal-analytics`, `signal-open` — each 8 workstreams, a seeded tree, protected files, and a judge |
| Configurations | 7: stock/ingress at rosters 1, 2, 4, 8 |
| Grading | the verifier replays submission code under Node's permission model — no network, no writes — against expectations the submission never sees, within a 16-invocation budget. `signal-open` is the exception: it is judged by a real Chrome over the DevTools protocol visiting the submission's own server, because a design cannot be checked by a signature |
| Observation | artifacts and a full grade at 60 s, 3 min and 10 min, retained as per-band hashes and check results |
| Cost accounting | the harness reads prices from the local model catalog at start and sums per-actor usage. **$2.72 for the flight; the deterministic work cost no model spend** |
| Blind review | labels shuffled, authorship redacted, artifacts frozen at settle, rated by a human on usefulness, completeness, clarity, coherence, overall |
| Watching | `missions:view` (observatory), `missions:trace` (live change stream), `missions:review` (tasting) |
| Keeping | `missions:retain` (workspaces + fence receipts into `traces/`, labelled settled/running/post-hoc), automatic at settle |
| Correcting | `missions:regrade` (re-grade retained artifacts with the judge as it stands, refusing when the fixture has moved) |
| OpenCode pin | `v2.0.32`, with a re-run compatibility probe (8 assertions) recorded as attempt 8, and `test/opencode-pin.test.mjs` asserting that pin, record and installed binary agree |
| Suite | 974 tests, ~41 s, each bounded at two minutes; `npm run check` for boundary and link integrity |

## 4. Today's flight

`signal-analytics`: Signal, a first-party Clarity-class site analytics platform — one small tag, an
ingest, a store, a dashboard, 27 criteria. Four cohorts, 32 actors, one repeat.

| Cohort | As flown | Re-graded | Tokens | Cost | Wall |
| --- | ---: | ---: | ---: | ---: | ---: |
| stock-eight · DeepSeek V4 Flash | 23/27 | **27/27** | 1.47 M | $1.11 | 998 s |
| ingress-eight · DeepSeek V4 Flash | 23/27 | **27/27** | 9.80 M | $1.52 | 791 s |
| stock-eight · GPT-5 Nano | 4/27 | 4/27 | 160 k | $0.04 | 390 s |
| ingress-eight · GPT-5 Nano | 1/27 | 1/27 | 711 k | $0.05 | 127 s |

Eight cheap agents built the platform to spec, twice, in thirteen and sixteen minutes. The fenced
cohort scored identically for **6.7× the tokens and 37% more money** — the same direction every
earlier study here found. All 32 actors reported successful native completion, which is the
difference between finishing and being right; Nano's failure is legible in the trace (it left
`tag/quality.mjs`, `tag/recorder.mjs` and the ingest side at seeded-stub size).

**All four of the recorded failures were defects in the judge**, not in the submission: an assertion
that contradicted its own spec, a diagnostic that could not survive process isolation, an ambiguity
about whether a handler's body is a string or an object, and a fix that silently anchored on a line
that no longer matched. Both numbers are kept; the flight's evidence is untouched and `regrade.json`
says what changed.

## 4a. What was lost, and what it says about retention

The flight directory is gone. `artifacts/` is gitignored and holds every flight's evidence, its
retained traces and the re-grade; it was present when the flight settled and absent a few hours
later, and nothing in this repository removes it — `rm` appears in `src/`, `scripts/`, `fixtures/`
and the tests only for directories the code creates itself, and every one of those is a `mkdtemp`.
The cause is not established.

What survives is what was written down: the figures in §4 and in
[the results document](mission-analytics-results.md), the commit message, and the four judge
defects. What is lost is the trace — the 74 fence decisions, the per-actor workspaces, and
`regrade.json`.

The lesson is not "back up `artifacts/`". It is that **retention into an ignored, unbacked directory
is not retention.** `npm run missions:retain` copies a flight's workspaces and receipts into the
flight directory, which is the right shape and the wrong location: the durable record of a flight
has to be a committed summary, and the bytes are a working copy that may not survive the week. The
next harness change is to write a compact, committable summary per flight — the numbers, the
criteria, the cost, the fingerprints — so that losing the directory costs the evidence's detail and
never its existence.

## 5. What this establishes, and what it does not

**Establishes.** A cheap model fleet can build a specified product to a contract it never sees, at
about a dollar a run, with the work traced, graded and retained. Stale-output detection works on the
deployed product, including transitively, and its cost is measurable — one wasted regeneration in
three. Cheap-model failures are legible rather than mysterious.

**Does not establish.**

- **No frontier comparison.** There is no frontier arm, so nothing here says whether coordination
  lets a cheap model reach what an expensive one reaches alone. That was the original question.
- **No design measurement, at all.** The design was mine: every module boundary, signature, default
  and refusal code. A perfect score means the fleet transcribed a specification, not that it produced
  one. My specification was itself ambiguous in three places and the fleet had no way to say so.
- **The tag never ran in a browser.** The grader's isolation has no DOM, so the mission's contracts
  are pure functions; the dashboard render in Chrome is the only live-browser check and it is the
  harness's author's, not the harness's.
- **n = 1 per cell.** One mission, one repeat, two cheap models. 27/27 twice is an existence proof,
  not a rate.
- **The fence's value is unmeasured here.** Same score with and without it, for 6.7× the tokens. The
  repository's earlier studies found no consistent coordination advantage, and this does not overturn
  them.
- **No RT status advanced, and no useful-benefit claim.** Nothing here qualifies the product.

## 6. Open

- **The frontier arm** on `signal-analytics`, same judge, a few repeats — the experiment that answers
  the original question. Estimate $20–60 for a first pass at frontier prices.
- **The underspecified mission — built, not yet flown.** `signal-open` ships the problem instead of
  the contracts and is judged by a real browser; the judge is proven fair from both ends (stubs
  0/12, a reference 12/12, a mutation fails exactly the two checks it should).
  See [the design mission](mission-design.md). What it still cannot measure is the ceiling — whether
  the dashboard is any *good* — which is the blind review's job.
- **The dollars for regeneration**: the model-driven recovery mode exists and is unblocked; the tax
  has never been priced in money rather than container seconds.
- **The product queue**: item 14's remaining slices (durable authenticated checkout, the private
  working-copy profile), item 11, and the unadopted command surface.
- **The storage question, closed**: the ledger is one value, and a probe stored and read back
  8 MiB on this runtime, so the documented 128 KiB per-value limit does not bind. Recorded where the
  caps are justified; no split is warranted.
