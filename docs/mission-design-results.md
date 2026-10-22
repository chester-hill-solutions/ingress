# Signal, underspecified: what the fleet designed when nobody told it what to build

Flown 2026-10-22, `artifacts/mission-flight-7a21bf33` (`fixtures/missions/signal-open.mjs`). One
cohort, DeepSeek V4 Flash, stock (no fence), eight actors, one repeat, a 20-minute cap.
**$1.60 and 1.84 M tokens.**

## Result

| | |
| --- | --- |
| Criteria | **12 of 12**, `correct: true` |
| Wall | 739 s |
| Observation bands | 60 s → 0/12 · **180 s → 12/12** · 600 s → 12/12 |
| Actors | 8 of 8 completed successfully |
| Cost | $1.6039, 1,843,561 tokens |
| Protected files | all intact — it instrumented the customer's pages from the outside |

The three-minute band is the interesting one. The judge does not grade a description of a product;
it starts the server, drives a browser through it and reads the dashboard. Twelve of twelve at
180 s means there was a working, instrumented, reporting product — with a masked DOM snapshot, a
typed-value-free wire and an escaped error — inside three minutes of the cohort starting.

## What it built, with its own vocabulary

Four files, 1,690 lines, and **not one file beyond the four it was allowed to touch**: a
single-file `server.mjs` (914 lines), a single-file tag (462 lines, **6,130 bytes gzipped** against
a 12 KB budget), a stylesheet, and a 165-line README. The analytic mission's specification forced
eight modules; given no specification, it chose one file each for the tag and the server.

**The wire protocol it invented** — nothing in the brief named any of this:

```json
{"v":1,"sid":"mvjxpirlg63ybpqz",
 "page":{"path":"/","title":"Home · Chester Hill Solutions","ref":"","vw":1280,"vh":813,"dev":"desktop"},
 "events":[{"t":"view", ...}, {"t":"snap","doc":{"t":"html","i":1,"a":{"lang":"en"},"c":[…]}}]}
```

`snap` is an indexed DOM tree — nodes carry an id, attributes, children and text separately — which
is the shape a session-replay protocol needs and the shape the brief never mentioned. One POST for
the whole visit.

**The dashboard it invented** (pictured in the flight's `acceptance/dashboard.png`): a status line
("Updated just now · 1 session · collecting since 3:28:56 PM"), eight stat cards with
plain-language sublabels (AVG. ENGAGEMENT "active time per visitor", AVG. SCROLL DEPTH "how far
pages are read", RAGE CLICKS "repeated frustration"), a two-column **What is working** / **What is
not** pair written as sentences rather than numbers, then a per-page table
(VIEWS · SESSIONS · AVG SCROLL · DEAD · RAGE · OUT · ERRORS · SUBMITS), a top-elements table, an
outbound-destinations table, and an error list with source.

**Capabilities it decided existed**: session replay (`/replay?sid=…`, with the dashboard saying "1
session available to replay"), engagement time, a scroll funnel at 25/50/75/100, form-field reach
("1 form field reached", with `SUBMITS` per page), outbound destinations, `data-private` masking
inside the snapshot, and a JSON API (`/api/summary`, `/api/replay`) plus `/healthz`. Verified: both
API routes and the replay route answer 200, and `/api/summary` carries the whole model.

## The privacy check is the strong one

Independently of the judge, from the acceptance pass's captured wire and dashboard:

| | |
| --- | --- |
| Card number on the wire | no |
| Email on the wire | no |
| `data-private` text on the wire | no |
| Either in the dashboard | no |

It sent a **full DOM snapshot** of the page and still kept the private paragraph out of it. That is
the hard version of the requirement: not "we do not read inputs" but "we serialise the document and
still know what to exclude" — and the brief asked only for the property, never for a mechanism.

## What this does not establish

- **One cohort, one repeat, one model.** An existence proof that a cheap fleet, given only the
  problem, designs and ships a working product that satisfies twelve outcome criteria. Not a rate.
- **The judge is a floor.** It proves the product runs, is instrumented, reports, and keeps nothing
  it must not. Whether the dashboard is *good* is a human judgement, and the blind review for this
  flight has not been rated.
- **Its numbers are its own vocabulary, and two differ from mine.** It reports **1 rage click** where
  the pass produced four clicks, and **AVG SCROLL 100%** where the pass scrolled to 60%. Both are
  defensible readings (one rage *group*; maximum depth rather than final position) and both are
  deliberately unscored — [the design mission](mission-design.md) says why. They are also the
  clearest illustration of the point: a spec would have decided those, and the design decided them.
- **Replay is verified only as "the endpoint answers."** That it reconstructs a session faithfully
  was not tested; `/replay?sid=` returned the empty state, because the server it was probed on had
  no sessions. The claim in the README is a design claim until someone checks it.
- **The trace is retained but unread.** The flight kept its workspace and fence receipts; 8 of 8
  actors succeeded and nothing here says they coordinated well, only that the artifact works.

## The evidence problem this flight inherits

The previous flight's directory vanished (`docs/state-of-play.md` §4a). This one is copied to
`~/.local/share/ingress/flights/` as well as `artifacts/`, and its numbers are in this document and
in `docs/flights/`, because retention into an ignored directory with no copy is not retention.
