# The Signal mission: a first-party site analytics platform

The fixture is `fixtures/missions/analytics.mjs`; the judge is in the same file. This is what it
asks for and what "done" means, so the criteria are readable without the code.

## The product

Signal is what an owner would use to see what is working on their own websites: one small tag to
paste on every page, an ingest, a store and a dashboard, with nobody else in the data path. The
reference capability is Microsoft Clarity — session replay, rage clicks, dead clicks, scroll depth,
JavaScript errors, engagement — at a fraction of the weight.

## The eight workstreams

One per actor at an eight-roster, which is how the flight ran.

| Workstream | Owns | What it must do |
| --- | --- | --- |
| bootstrap | `tag/config.mjs`, `tag/session.mjs` | Parse the tag attributes with documented defaults, honour do-not-track and opt-out, and own the deterministic session id and inactivity roll |
| quality | `tag/quality.mjs` | Rage clicks over a time window and radius, dead clicks, scroll milestones, engagement excluding idle gaps, outbound clicks |
| recorder | `tag/recorder.mjs` | DOM snapshot, diff, and masking that is absolute: input values are never serialised |
| errors | `tag/errors.mjs` | Bounded message and stack, repeats counted rather than repeated, a rate cap per minute |
| batching | `tag/batch.mjs` | Caps on count and bytes, flush decisions from interval and visibility, the wire request including the unload beacon |
| ingest | `ingest/handler.mjs`, `ingest/store.mjs` | Typed refusals at the edge, accepted batches applied to a store with caps that record what they dropped |
| reporting | `dashboard/view.mjs`, `public/dashboard.css` | The owner dashboard: per page, funnel, errors, playback payload, everything escaped |
| integration | `app.mjs` | `runScenario` end to end over the seeded site and session |

## The bar

- the tag ships **≤ 12 KB gzipped for the whole `tag/` directory**, every import inside it resolves,
  and it imports nothing outside it
- input values are never serialised, and a `data-signal-mask` subtree is redacted at every depth
- ingest refusals are typed — unknown site 403, malformed 400, oversized 413, opted-out 204 — and a
  refusal changes no stored state
- every dynamic value in the dashboard is escaped
- the seeded site and visitor session are consumed, never retyped

## How it is judged

The verifier replays a scripted visitor session through the submission's own tag logic under Node's
permission model with no network and no writes, and checks the analytics that come out against
figures computed in the parent from that same script: three pageviews, one rage group of four clicks,
five dead clicks, milestones at 25/50/75 and not 100, 12000 ms of engagement across the idle
threshold, one error counted twice, and a funnel that reaches three depths in one session. The
submission never sees an expectation.

Twenty-seven criteria, sixteen submission invocations, and the seeded stubs score **0/27** — checked
rather than assumed, because the first version of the judge awarded two points to a submission that
wrote nothing.

## Ambiguities this mission carries

Recorded rather than quietly resolved, because a judge can only be as good as its contract and these
were found by submissions reading it differently than I did:

- **The ingest body's type.** `handle` returns `{status,headers,body}`; the contract never said
  whether `body` is a string or an object. A real HTTP handler returns a string, and the judge now
  reads either.
- **`events` in an acceptance.** Whether it is the count or the events themselves was not pinned; the
  judge accepts either.
- **"A complete HTML string."** The dashboard renders a fragment with one `<main>` and links no
  stylesheet, which satisfies the letter of the contract and leaves the view unstyled unless a page
  links the CSS.

## Flown

2026-10-22, four cohorts, 32 actors, $2.72: [results](mission-analytics-results.md). The fixture is
frozen from that point — `test/mission-freeze.test.mjs` pins the seed hash it was graded against,
because editing it afterwards makes the artifacts ungradable rather than re-gradable.
