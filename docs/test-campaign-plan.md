# Ingress test campaign: staged agents, an overseer, and coverage that maps to the claims

**Date:** 2026-10-02. **Status:** proposed plan, not yet executed. No RT status
advances. Nothing here qualifies product benefit.

**Deadline context:** the competition submission closes 2026-10-14 23:59 PDT,
which is 12 days from writing. Sequencing below front-loads whatever a judge or
a reviewer would otherwise have to take on faith.

---

## 0. What I checked before planning, and what changed

Two findings reframe this plan, and both came from running things rather than
reading documents.

**The 10 failing tests were environmental, not real.** The Oct 1 handoff recorded
`269 tests, 259 pass, 10 fail` and attributed the failures to "pre-existing in
`mission-verifier` and the graph fixtures, unrelated to any of this work." That
attribution is wrong in a way that matters.

```
node --version                        # v25.9.0
npm test                               # 280 tests, 270 pass, 10 fail

PATH=/opt/homebrew/Cellar/node/26.3.1/bin:$PATH npm test
                                      # 280 tests, 280 pass, 0 fail
```

`src/mission-verifier.mjs:17` gates on
`Number(process.versions.node.split('.')[0]) >= 26`, because the Node 26
permission model (`node --permission --allow-fs-read=…`) is what denies submitted
code access to the private oracle. On Node 25 the permission model is absent, the
refusal path fires, and 10 tests fail. `package.json` already declares
`"engines": { "node": ">=26" }`.

**Consequence for this campaign: every live run must pin Node 26.** Otherwise the
independence guarantees the whole project rests on are silently absent, and the
campaign produces results that look valid and are not. This is the single most
important operational rule below.

**There is no Cloudflare code in this repository.** Every match for
`cloudflare|wrangler|CLOUDFLARE|snapshotContainer|WorkerEntrypoint` across
`src/`, `scripts/`, and `fixtures/` is inside `docs/*.md`. The Containers
snapshot isolation, the egress gate, and the Artifacts repository are documented
results of spikes run against account `6b149553c5075c79bbc132c481f387fe` with
`cf` v1.0.0-beta.10; there is no committed harness for any of them.

This matters for what "representative" can mean. The executable system under test
is **a Node harness that drives the OpenCode binary and observes it**. Snapshot
isolation is a documented platform capability, not a property this repo can
exercise. A test plan that claims to test isolation here would be claiming
something untrue, so I have put the isolation gap in §6 as a build item rather
than pretending a test covers it.

**Live paths work.** `node scripts/probe.mjs --real --awareness` just ran green
against the real model: `correct:true, readBarrier:true,
notificationOpportunity:true`. The binary is pinned and present
(`~/.opencode/bin/opencode`, `opencode v2.0.16`), `models.json` exists, and
`model.json` selects the provider. Note the run recorded
`errors:[{actor:"consumer",code:"native_stream_unavailable"}]` while still
passing — retained as-is, per the project's all-outcomes-retained rule.

---

## 1. What the system can and cannot do today

Every claim in this plan maps to a real flag. Where something needs building, I
say so rather than writing a test for it.

| Capability | Status | Command |
| --- | --- | --- |
| Two-agent read-barrier probe | works live | `node scripts/probe.mjs --real [--baseline\|--awareness]` |
| Deterministic probe twin | works | `npm run demo` |
| Roster build, 4 or 16 builders | works | `node scripts/squad.mjs --real [--fixture=extensions]` |
| Batched concurrency only | works | `--max-concurrent=N` — uniform batches |
| **Staggered / condition-triggered admission** | **missing** | no delay, jitter, or event-trigger knob exists |
| Single-agent focused repair | works | `node scripts/repair-game.mjs --real --root … --prior …` |
| Repeated 2-agent benchmark study | works | `node scripts/benchmark.mjs --real --repeats=N --parallel=N` |
| 8-stream mission benchmark | works | `node scripts/mission-benchmark.mjs --real [--plan]` |
| Blind human review server | works | `npm run missions:review -- --directory=…` |
| Mid-flight graded snapshots | works | mission bands at 60s/180s/600s |
| 32-participant load apparatus | works, 0 model calls | `node scripts/scale.mjs` |
| **Live mid-run human intervention** | **missing** | notices are policy-driven; no external control channel |
| Byte-level snapshot isolation | **not in this repo** | documented only |

---

## 2. Stage design: what each stage is allowed to prove

The project's discipline is that a negative result is only meaningful if the
apparatus could have detected a positive. Each stage below therefore names the
claim it can support and the claim it cannot. This is the part most likely to be
worth doing carefully, because criterion 1 of the rubric scores *quality of the
prototype* and a harness that can only produce one answer reads as unfinished.

| Stage | Shape | Claim it can support | Claim it cannot support |
| --- | --- | --- | --- |
| **A. Negative controls** | Fixtures that must fail | The checks actually detect failure | Anything about product benefit |
| **B. Deterministic scale** | 32–64 participants, 0 model calls | Relay/context cost, capacity ceilings | Live concurrency |
| **C. Awareness paired trials** | N repeats, off vs on, one variable | Whether a notice changes an outcome | That it improves outcomes |
| **D. Staggered admission** | Builders arrive on different triggers | Behaviour under realistic arrival | Simultaneity claims |
| **E. Overseer live** | Human adjusts mid-flight | That intervention is possible and recorded | That intervention helps |
| **F. Mission flight** | 8 streams, graded mid-flight | Correctness over time under load | RT-1 benefit |
| **G. Blind human taste** | Reviewers score blind samples | Perceived usefulness/clarity | Which model or config won |

**Stage A is not optional and not padding.** `plan.md` records that browser QA
caught an undefined timeline variable and DOM mount errors that 58/58 static
checks missed. A harness that only ever passes cannot distinguish "my checks are
good" from "my checks are blind." Negative controls are how you show the latter
is false.

---

## 3. Queueing agents at different times, based on different things

`src/squad.mjs:349` currently does this:

```js
concurrency = maxConcurrentNative ?? fixture.tasks.length;
for (let offset = 0; offset < fixture.tasks.length; offset += concurrency) {
  const group = fixture.tasks.slice(offset, offset + concurrency);
  …
}
```

Uniform batches. Every agent in a batch starts together, the batch drains, the
next begins. There is no delay, no jitter, no event trigger anywhere in the
file — I grepped for it. So "queue agents at different times based on different
things" requires building the scheduler, and the interesting part is *what the
trigger is*, not the delay.

Five admission policies worth testing, because they stress different assumptions:

**P1 — simultaneous (control).** Current behaviour, `--max-concurrent=` unset.
Baseline for everything else. Records `native execution peak16`.

**P2 — fixed stagger.** Agent *n* admitted at `n × delayMs`. Tests whether the
system's coordination story depends on true simultaneity, and separates "many
agents at once" from "many agents overlapping." Implementation: one `delayMs`
before each `setup()`.

**P3 — dependency-gated.** An agent is admitted only when its declared
`dependencies` have been written at least once *and* its `decisionCut` shows a
read at or after that revision. This is the policy the product actually
advocates, so it is the one that most deserves evidence. The fixture already
carries the dependency graph (`engine.mjs` is depended on by all 14 module
specs; `progress` also depends on `scoreboard.mjs`), so the graph exists —
nothing consumes it for admission.

**P4 — contention-gated.** Admit agent *n+1* only while ≤ *k* peers are mid-write
to a shared file. Uses `observeFiles` revisions and `WorkspaceState` rooms. Tests
whether Ingress helps *more* when there is actual contention, which is the only
regime where a coordination mechanism could plausibly pay for itself.

**P5 — event-gated (the overseer arm).** An external signal admits the next
agent. This is what §5 needs, and it is the only policy that makes the human
overseeer a real participant rather than an observer of a script.

**P4 deserves a flag.** Every previous study found coordination does not help, and
the honest explanation may be that the fixtures never produced contention worth
coordinating. P4 is the first policy that manufactures it deliberately. If
Ingress helps nowhere but P4, that is a far more interesting and defensible
finding than another null result at low contention.

### What each policy must record

A stagger that isn't recorded is indistinguishable from a stagger that didn't
happen. Per actor, extend the existing evidence with:

- `admissionTrigger`: `'simultaneous' | 'stagger' | 'dependency' | 'contention' | 'event'`
- `admissionDelayMs`: intended offset from run start
- `admissionActualDelayMs`: measured, from `startedAt` to admitted
- `admissionGateState`: what the gate observed when it fired (e.g. `{producerPath, revision, readRevision}`)
- `admissionGateWaitMs`: how long it waited
- `admissionPolicy`: `{ id, delayMs, jitterMs, gate }` at the run level

`admissionActualDelayMs` is the load-bearing one. An intended delay that did not
happen is a finding, not a footnote.

---

## 4. The overseer: a human watching work land and adjusting on the fly

This is the most novel part of the plan and the part I am least confident about,
so here is the mechanism and the failure modes, stated plainly.

### What exists to build on

- **Live dashboards.** `scripts/benchmark-view.mjs --evidence=…` and
  `probe.mjs --serve` already stream state to `127.0.0.1`. Read-only today.
- **Steering, already proven.** `src/trial.mjs` sends a `delivery:'steer'`
  notice mid-run and records `contextProof`. The probe I just ran recorded
  `notificationOpportunity:true`.
- **A safety property worth keeping.** `repair-game.mjs:33` records
  `automaticChangeMessages: 0` — a human-directed repair run takes exactly one
  task and schedules no follow-ups. An overseer arm must not quietly become an
  autopilot; the intervention has to be a human act with a recorded timestamp.

### What is missing

No external control channel. Notices are generated by `NotificationPolicy`
(`src/squad.mjs:74`) from observed file revisions, with `quietMs: 2_000`,
`maxNotices: 3`, `delivery: 'queue'`. An overseer cannot currently inject a
decision, reprioritize a queued agent, or cancel one.

### Proposed mechanism

Add an overseer control server bound to `127.0.0.1`, mirroring the existing
`blind-review.mjs` security posture exactly (that file is the in-repo precedent:
origin-checked, body-bounded, CSP nonce, `lstat` guards, state machine).

```
POST /overseer/admit       { actorId }              admit a gated agent early
POST /overseer/defer       { actorId }              push to the back of the queue
POST /overseer/steer       { actorId, text }        deliver a steer message
POST /overseer/cancel      { actorId }              stop one actor, keep the run
POST /overseer/note        { text }                 annotate, no agent effect
GET  /overseer/state                            live roster, gates, notices, revisions
```

Every accepted action appends to the evidence with `at`, `actorId`, `kind`, and a
hash of the exact bytes sent. The rule: **the overseer may change what happens
next but never rewrite what already happened.** No retroactive edits to actor
outcomes, no post-hoc verification changes.

### Making the overseer representative rather than decorative

An overseer who watches everything and does nothing produces no evidence. An
overseer who acts on everything produces unrepresentative data. Four arms, each
a full run:

- **O0 — shadow.** Overseer watches, records notes, never acts. Measures what a
  human *notices* versus what the policy automatically fires. If the human
  notices something the policy never flagged, the policy has a gap.
- **O1 — reactive.** Acts only on policy-fired notices: confirms, defers, or
  re-steers. Tests whether intervention on the existing signal changes outcomes.
- **O2 — proactive.** Acts on the dependency graph and observed revisions, ahead
  of the policy. Tests whether earlier intervention beats on-time intervention.
- **O3 — adversarial.** Overseer is given a specific failure to induce — force a
  stale read, hold a shared file, let two agents race a dependency — and
  intervenes to recover. Tests whether the mechanism is load-bearing under
  deliberate stress.

O0 and O3 are the two that teach something the others cannot. O0 measures the
gap between human attention and automated policy. O3 is the only arm that
answers "does this actually prevent the failure it claims to prevent?"

### Honesty constraints

Three that must not be fudged:

1. **Intervened runs are a different condition.** Never pooled with
   non-intervened runs. Report them separately, always.
2. **The overseer is a single unblinded human.** No n, no error bars. Every
   overseer observation is anecdotal and labelled as such. This is the weakest
   evidence in the plan and I will not present it otherwise.
3. **An O3 recovery is not a prevention.** Recording "the human fixed it" as
   though the system prevented it is exactly the failure mode this project's
   claim protocol exists to prevent.

---

## 5. Full and creative coverage: the matrix

Represents the range of what the harness can do, weighted by what a reviewer
would want to see work.

**Fixture families (existing, exercised).** `money` and `strict-format` (tight
contracts), `shared-features` (true shared file), `dependency-refactor`
(ordered work), `cache-ttl` (time-dependent), `human-priority` (protected
`HUMAN.md` plus adversarial `notes.txt` with an embedded injection payload).

**New fixtures I would add, each targeting a claim:**

- `contention-pair` — two builders, one file, forced interleaving. Directly
  exercises P4, the only regime where coordination could pay off.
- `stale-read-bait` — a third agent changes a file *after* a peer has read it but
  *before* the peer acts on the stale content. Tests the notification path
  end to end. The existing `readBarrier` in `trial.mjs` is the mechanical
  primitive; this makes it a fixture.
- `reverse-order` — dependencies satisfied in reverse declaration order.
  `plan.md` already records affinity-based stale-read suppression was removed
  because preferred file focus cannot prove authorship; this tests that removal.
- `partial-overwrite` — two agents write overlapping line ranges, non-adjacent.
  Tests whether observer-only tracking (`nativeWritesFenced: false`) detects
  anything meaningful.
- `deadline-squeeze` — deadline set below known completion time. Confirms
  deadline outcomes are recorded as outcomes and not silently dropped.
- `injection-escalation` — adversarial content in a *dependency* file rather
  than a notes file, so it arrives through the context-assembly path. The
  existing containment test covers hostile peer text; this covers hostile
  dependency content.

**Dimensions to cross:**

| Dimension | Values |
| --- | --- |
| Admission policy | P1–P5 |
| Overseer arm | none, O0–O3 |
| Roster | 4, 16, 32, 64 (64 = capacity ceiling, `squad_capacity_exceeded` above) |
| Model | `space-bunny-free` control; `gpt-5-nano`, `deepseek-v4-flash` if catalogued |
| Context | 32 KiB, truncated variants |
| Notice policy | `quietMs` 2s / 0.5s; `maxNotices` 1 / 3 / unbounded |
| Deadline | generous, tight, below-completion |
| Isolation | Node 26 permission model on / deliberately off |

Every cell is a real invocation. What I will *not* do is present the cross
product as a power analysis; it is a coverage map, and the cells that matter are
chosen before running, not after seeing results.

---

## 6. Build items this plan depends on

Ordered by what blocks the most.

1. **Pin Node 26 everywhere.** Add a preflight check to every `--real` entry
   point that refuses to run on < 26 with a message naming the permission model.
   Without this the campaign can produce confidently wrong results. *Blocking for
   all live arms.*
2. **Admission scheduler with policies P1–P4.** `--admission=`, `--delay-ms=`,
   `--jitter-ms=`, `--gate=`. Records the fields in §3. *Blocking for stages D and
   E.*
3. **Overseer control server (P5).** As specified in §4. *Blocking for stage E.*
4. **Pin the OpenCode version check.** `src/process.mjs` requires stdout to be
   exactly `opencode v2.0.16`. It is currently correct here; make a mismatch a
   loud, named failure in the evidence rather than a thrown error.
5. **Correct the handoff and `plan.md` on the test baseline.** The "10 pre-existing
   failures" claim is in `HANDOFF-2026-10-01.md` and should not survive
   unchallenged; it sent me looking for bugs that do not exist.
6. **Decide the isolation question.** Either commit the Containers spike harness
   so isolation is testable, or state in the submission that isolation is a
   platform property this project qualifies for but does not itself test. The
   second is honest and cheap. The first is a real project. Do not let the gap be
   discovered by a judge who greps for `wrangler.toml`.

---

## 7. Execution order

Sequenced so that anything expensive is preceded by the cheap check that would
invalidate it.

**Phase 0 — baseline (no model calls, minutes).**
Node 26 preflight; `npm test` 280/280; `npm run check`; `npm run demo`;
`scripts/scale.mjs` at 32 and 64 participants; `missions:plan`; the two
`--native-local` smoke scripts (`opencode-plugin-smoke`, `benchmark-native-write-smoke`),
which use the installed binary with a loopback provider and **zero provider
credentials**. If these fail, stop; nothing above them is meaningful.

**Phase 1 — negative controls (no model calls, ~1h).**
Build `contention-pair`, `stale-read-bait`, `reverse-order`, `partial-overwrite`,
`injection-escalation`. Verify each fails against a deliberately broken
implementation and passes against a correct one. *This is the phase that makes
every later positive mean something.* Record the mutation-testing result per
check, not just the pass count.

**Phase 2 — live smoke (model calls, ~30min).**
`probe.mjs --real` both arms, several repeats, confirming `readBarrier` and
`notificationOpportunity` are reliable enough to build on. Retain all outcomes
including the `native_stream_unavailable` I just saw.

**Phase 3 — admission policies (model calls, hours).**
P1 and P2 first as the cheapest contrast; P3 and P4 after, since they are the
substantive ones. Roster 4 before 16; the 16-builder run is the expensive one and
should not be the first thing that runs.

**Phase 4 — overseer arms (model calls, hours, human present).**
O0 first, entirely hands-off but recording attention. Then O1, O2, O3. I want O0's
notices-to-policy gap before deciding how much weight O1–O3 can carry.

**Phase 5 — mission flight (model calls, longest).**
6 missions × selected configs, with the 60s/180s/600s graded snapshots. Feeds the
blind review in Phase 6.

**Phase 6 — blind human taste (human, hours).**
`npm run missions:review` over the Phase 5 samples. Reviewers score
usefulness/completeness/clarity/coherence/overall blind; `neutral()` withholds
authorship. This is the only evidence in the campaign that speaks to rubric
criterion 3 (ease of use, 25%).

**Phase 7 — synthesis and honest writeup.**
Every cell, including failures. Explicit statement of what each arm can and
cannot support. If the answer is "Ingress helps nowhere but under manufactured
contention", that is the finding and it is a real one.

---

## 8. What this plan does not do

- It does not qualify RT-1. Nothing here is a comparative benefit measurement;
  Stage C is paired but the prior study already showed pairing alone is not
  enough, and one more null result is not a qualification.
- It does not claim snapshot isolation. That is a documented platform result
  with no harness in this repository.
- It does not establish the overseer as effective. It establishes whether the
  mechanism can be built, recorded, and operated. A single unblinded human is
  anecdotal evidence about a mechanism, not evidence the mechanism works.
- It does not assume the negative result will hold. P4 and the mission flights are
  the arms most likely to produce a positive, and I would rather find that
  honestly than have designed them to fail.

## 9. Open questions for the user

1. **Overseer availability.** Stage E needs a human present for hours, deciding
   in real time. Is that you, and on which days? If not, stages D and E slip and
   the campaign is Phase 0–3 plus 5–7.
2. **Contention fixtures: how adversarial?** P4 manufactures conflict. I have
   specified fixtures that are hard but honest — real overlapping writes, not
   sandbagged ones. Do you want them harder than that?
3. **Node 26 for CI.** Should the preflight be a repo-level guard (so it can never
   be forgotten again) or a local convention?
4. **The `cf` half.** The `cf` CLI issue from this session's other thread is
   separate and unresolved. Is it in scope for the competition entry, or does it
   stay its own issue?