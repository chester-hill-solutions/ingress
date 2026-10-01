# Cloudflare platform plan and the next Git competition entry

**Date:** 2026-10-01. **Status:** proposed. Step 1 has since been executed — see
[the Artifacts spike report](artifacts-spike-report.md). No Worker is deployed and no
deployment is certified by either document.

This plan does two things. It records which Cloudflare platform primitives Ingress
qualifies as a host, and it scopes a competition entry for *"Build the next GitHub"*
(submissions close 2026-10-14). The competition framing is separate from RT-0–RT-6 in
[the multiplayer plan](realtime-multiplayer-plan.md) and does not advance any RT status.
The [rename record](rename-to-ingress.md) is prior provenance for the product name.

## What the platform changes about our constraints

Three releases between 2026-09-30 and 2026-10-01 alter what this repository may build
on. Each claim below is qualified by its own availability, because availability is the
part that decides the schedule.

| Primitive | Qualifies as | Availability |
| --- | --- | --- |
| Artifacts Workers binding | Repository substrate, replacing local-directory observation | Open beta, **Workers Paid only** |
| Artifacts event subscriptions | The `file.observed` source, as a durable ordered stream | Open beta |
| Durable Objects | Durable home for `WorkspaceState` and `DecisionLane` receipts | GA |
| Clef / Clef-flash | Bounded decision layer, replacing the Jev evaluation arm | Released 2026-10-01 |
| Workers Builds + Previews | Independent verification of a candidate change | GA |
| Stow scoped checkpoints | Durable input basis for an accepted change | Contract only, W09 unimplemented |

Two constraints are load-bearing and easy to miss. **Artifacts billing begins
2026-10-14**, the same day submissions close, at 10,000 operations/month included then
$0.15 per additional 1,000, plus storage above 1 GB-mo. And **KV Instant is private
beta** behind a 1 MB namespace ceiling, so it cannot be a dependency.

## The problem we are solving

Git models artifacts, never intent. It can say what a file contained at a commit. It
cannot say who is working on it, what they are trying to do, whether their last read is
still current, or why a change was made. Every chokepoint in multi-agent use follows from
that single omission: the only way to avoid a merge conflict in git is to not touch the
same file, and nobody can know that in advance.

Cloudflare's post names the same gap and states it is not building the layer above
Artifacts. The submission requirement is *"at minimum, multiple agents working on changes
concurrently."* That is the floor, not the differentiator.

## What the entry argues

The honest argument, because our own study does not support a faster one.

**Coordination is a correctness instrument, not a speed instrument.** The repeated native
study recorded 6 treated wins / 4 stock wins / 8 ties on Space Bunny, 1 / 1 / 7 on
DeepSeek, and 0 / 3 / 6 on GPT-5 Nano. Eight-agent teams produced 8 correct artifacts out
of 9 and completed 0 of 9 inside the 90-second budget. The artifacts were right and the
coordination still did not close. That row is the thesis: do not sell coordination as a
speedup.

**What coordination buys is falsifiable evidence.** Every `DecisionLane` receipt carries
`evidenceDigest`, `semanticDigest`, `staleAfterAdmission` and `nativeReceiptID`, and every
read carries `confidence` of `verified`, `temporal` or `unknown`. Git cannot answer
"did this agent see the current version?" This can, and it can say when it does not know.
`docs/CAPABILITIES.md` already states the limit honestly: verified context serialization
establishes exposure, not behavioural adaptation.

**Admission is a handshake, not a broadcast.** `joinFile` returns the file's current
state, peers, their intentions and coverage; `setIntention` records a revisioned
declaration with a five-minute expiry that cannot revive once an execution settles. Two
compatibility properties follow directly: agents that never declare never block anyone,
and a declared scope makes overlap decidable without reading either diff.

**Boundedness is designed.** 32 KiB context with declared truncation, at most three
notices per actor, 2 s coalescing, 64 participants, 128 source streams, 128 observed files,
and visible rejection of unsupported rosters. At the scale the competition post describes
these limits are the feature, and `scale.mjs` already measures 32 participants through
2,000 events with zero models.

## Delivery plan

Ten working days to 2026-10-14. P0 is the minimum that still argues the thesis; P1 is
additive and is cut first under pressure. Days are estimates, not commitments, and each
step lists what would make it fail.

### P0

| # | Step | Days | Failure mode |
| --- | --- | --- | --- |
| 1 | Artifacts spike: create, fork, push, subscribe, read | 1 | **Done.** Failure mode did not fire; see [spike report](artifacts-spike-report.md). `fork` naming remains untested from the binding |
| 2 | Durable `WorkspaceState` behind a Durable Object | 2 | `ingest()` dedup and `liveSequence` stop being correct across restarts |
| 3 | Artifacts as observation source, replacing `file-observer` | 2 | Event lag exceeds agent turn latency; observation is useless in time |
| 4 | Cross-host resumption: a second Durable Object adopts a dead agent's cut | 1 | Cut adoption needs live process state we cannot serialize |
| 5 | Clef behind the deterministic decision boundary | 1 | New-model roughness; the deterministic lane already stands alone |
| 6 | Ratchets with falsification tests | 1 | A ratchet that cannot go red is deleted, not shipped |
| 7 | Evidence-trail view and `make demo` | 2 | Scope creep into a product UI instead of a receipt |

Step 4 is the scene that wins the entry: an agent dies mid-task, and a different host
resumes its intention and read basis. Neither git nor a local filesystem can do this.

Step 7's `make demo` runs headless against a seeded fixture so the run instructions are
one command and the video is not the only proof the system works.

Step 7 carries more weight than its position suggests. The published rubric is 50%
originality and quality of the prototype, 25% effectiveness of multi-agent concurrency and
coordination, and **25% ease of use and product/user experience**. A quarter of the score
is user experience, so a legible first-run path is not polish here — it is a scored
requirement. See [the submission protocol](competition-submission.md) for the rubric in
full and its consequences for this plan.

The same rubric is a caution on the honest-negative framing. Leading with results where
eight-agent teams produced 8 correct artifacts and 0 of 9 in-budget completions will read
as rigour or as an unfinished prototype depending entirely on whether the surrounding
artifact is visibly complete. That argues for a demo that runs first time, a checked
run-instructions path, and negative results presented alongside the mechanism that
explains them rather than in place of one.

### P1, only if P0 is clean

- Workers Builds and Previews as an independent verification gate before acceptance.
- Scale the recorded run past 32 participants with the deterministic apparatus.
- Declared dependency graphs from resolvable imports, replacing hand-authored fixtures.

### Explicitly out of scope

- Semantic merge or automatic conflict resolution.
- File claims, exclusive ownership, or refusing native writes.
- Remote multiplayer, CRDT convergence, shared editing.
- Hosted control plane, multi-tenant product surface.
- Any speed or cost-reduction claim.

### Dependency order

Step 1 gates everything. If Artifacts does not hold up on day one, the entry becomes a
Durable-Object-backed local-substrate demonstration, which is a smaller claim but still an
honest one, and it keeps the existing 269 tests as evidence.

## Boundaries this plan does not move

Ingress extends Stow through its public Go package
`github.com/chester-hill-solutions/stow-s3/pkg/stow` and the published
`@chester-hill-solutions/stow-s3` client. It does not consume Stow through MCP, and it
maintains no competing authoritative storage journal. Stow owns storage identity,
guarded-save admission, saved artifacts, retention and transfer; Ingress owns what those
facts mean for active work.

**Ingress supplies no compute.** Where an agent runs is caller-owned execution, and the
platform's own division agrees: a Durable Object retains identity, state, policy and
lifecycle while a container supplies only the environment. Nothing in this plan adopts
container execution.

**Artifacts replaces the observation substrate, not the boundary.** The `artifacts.repo`
event source is the successor to `file-watcher` in `WorkspaceState.ingest()`. Storage
scope matching and ACL enforcement remain core-owned; semantic relevance filtering
remains extension-owned.

**Stow's published documentation still names the old product.** It has its own dirty
working tree and its own ADR gate, so that rename is a separate change in a separate
repository. Ingress does not depend on it landing first.

## How we will know it worked

Use the repository's existing gate discipline, and require each gate to satisfy three
properties recorded in `chester-hill-solutions/docs/PACKAGE-CONVENTIONS.md`: an
unresolvable input is an error rather than a zero; the thing checked is the thing that
ships; and a passing result must be a claim someone could have falsified.

| Gate | Target | Falsification test |
| --- | --- | --- |
| Change stayed inside declared scope | 0 violations | Plant an out-of-scope edit; the gate must go red |
| Every accepted line has a recorded decision | 0 violations | Drop one decision; the gate must go red |
| Every read basis is `verified` | 0 violations | Ingest a `temporal` read; the gate must go red |
| Cross-host adoption preserves the cut digest | 0 violations | Corrupt the digest across handoff; the gate must go red |

A gate whose falsification test passes anyway is decoration and is deleted rather than
demonstrated. This is the failure recorded against four existing gates in the sibling
repository, where two scanned a path that did not exist and reported `0` while a real
violation sat in the real directory.

Retain every assigned run, including deadline and failure outcomes, as the existing
study protocol requires. Any gap in observation coverage stays visible as
`coverage.complete: false` with a named reason rather than being smoothed away.

## Risks

| Risk | Response |
| --- | --- |
| Artifacts open beta instability near the deadline | Spike on day one; local-substrate fallback exists |
| Billing starts 2026-10-14 | 10,000 operations/month covers a recorded demo; delete forks after each run |
| Clef released the day of the entry | Deterministic lane is the floor, not a fallback for it |
| Judges read our own negative results as weakness | Lead with them; the eight-agent row is the argument |
| The demo-video harness in `chester-hill-solutions` is unreachable | That tree is 69 commits behind and dirty; treat the harness as optional |
| Scope creep into a product | P0 is the thesis, not a UI |

## Next action

Run step 1. Everything else in this plan is contingent on whether Artifacts behaves as
documented. No RT status advances, and this entry ships the same honesty constraints as
the existing study: outcomes are retained, limits are stated, and a passing result is
always a claim someone could have falsified.