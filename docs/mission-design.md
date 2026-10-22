# The design mission: same product, no contracts

`signal-analytics` was measured on 2026-10-22 and the honest reading of it is uncomfortable: the
design was mine. Every module boundary, every signature, every default, the refusal codes, the wire
schema, the dashboard's sections. All twenty-seven criteria were forms of *"did you do what I
said"*, so 27/27 meant **spec fidelity**, not design — and the fleet that scored it had no channel
to say that my spec was ambiguous in three places. It picked a reading and passed.

`signal-open` is the same product with the design left in.

## What the submission is given

A customer's two pages (`site/index.html`, `site/campaigns.html`, protected), with their own
behaviour: a button that does nothing, a link that leaves the site, a form, a `data-private` note,
and a button that throws. A `BRIEF.md` that says what the product is for and, in six lines, the
product facts without which nothing could observe it:

| Fact | Why it is fixed |
| --- | --- |
| `node server.mjs` on `$PORT` | an observer has to be able to start it |
| `/` and `/campaigns` serve those pages, with the tag in them | the product is "the page carries the tag" |
| `GET /dashboard` | the owner's view has to be findable |
| tag ≤ 12 KB gzipped, served from your own host | the weight claim and "nobody else in the data path" |
| never keep what a visitor typed; never record `data-private` | the requirement a working product and a lawsuit share |

## What it is not given

No event name, schema, module layout, threshold, storage shape, dashboard markup, or field. The
submission decides what to collect, how to batch it, what to call it, where to keep it, and what the
owner sees. The only editable paths are `server.mjs`, `public/signal.js`, `public/dashboard.css` and
`README.md`, and it may add files.

## How it is judged

By a browser, because a contract made of function signatures cannot measure a design. The judge
(`fixtures/missions/signal-open.mjs`, driving `src/browser.mjs` over the DevTools protocol):

1. starts `node server.mjs` under the permission model, bounded to its own workspace plus the
   network it needs to listen;
2. fetches `/`, discovers the tag **from the served page** (a page that does not carry one is not
   instrumented) and weighs it;
3. visits `/campaigns` calmly, then `/` where it scrolls, rage-clicks the dead button four times,
   types a card number and an email, clicks the throwing button, and leaves through the outbound
   link — with real mouse events, real typing and a real unload;
4. reads `/dashboard` the way an owner would, and checks the wire the tag actually produced.

Twelve criteria, all outcomes: it runs, it serves the pages, the page carries a tag, the tag is
within budget, the tag does not throw, the visit appears, the error appears, the error is escaped,
nothing typed is on the wire or in the store, the private subtree is never recorded, nothing talks
to a third party, and the README tells a customer how to embed it.

## What the judge deliberately does not score

**Scroll depth and rage clicks.** The analytic mission checks both arithmetically, and this one
checks neither. Asserting them here means guessing the submission's vocabulary — "the deepest depth
is shown as a percentage between 50 and 100" is a design decision, not an observable — and the
looser version ("a number the calm visit did not have") is satisfied by any dashboard that prints a
timestamp. A check that a static dashboard passes is worse than no check, because it reads as
evidence. So they are recorded here as unscored, and the blind review is where a human decides
whether an owner can actually tell what happened.

**The ceiling.** This judge is a floor: it can prove the product runs, is instrumented, reports, and
keeps nothing it must not. It cannot prove the dashboard is good. That split is stated rather than
implied by a score.

## Is the judge fair?

Tested from both ends, because either failure is fatal:

| Test | Result |
| --- | --- |
| The seeded stubs | **0 of 12** — a submission that writes nothing scores nothing |
| A reference implementation (`fixtures/reference/signal-open/`) | **12 of 12** in 4.9 s — the floor is reachable by following the brief and nothing else |
| A mutation: the tag sends what was typed, the dashboard stops escaping | **exactly two** checks fail — `never-collects-typed-values` and `dashboard-escapes-the-error`, and nothing else |

The reference is deliberately plain — a table, a list, one closure for the tag — because it exists
to prove reachability, not to show what a good answer looks like. A submission that does something
more interesting should pass at least as easily.

## The honest cost

- **Weaker isolation than the analytic mission.** The submission runs as a *program*, not as an
  isolated function: the server is spawned with the permission model bounded to its workspace plus
  `--allow-net` (it has to listen), and Chrome loads what it serves. That is recorded, not implied
  away. A submission that hangs is killed by deadline.
- **A browser is required.** `browserAvailable()` decides; a machine without Chrome returns
  `evaluator_refused_browser_unavailable` with every criterion failed and `isolationRefused: true`,
  the same way the isolated verifier reports a runtime without the permission model. The submission
  is never blamed for the instrument being absent, and the tests skip with that reason.
- **No `reviewInvocation`.** The blind review's sample is a rendered string; this artifact is a
  running server. Its reviewable form is a served instance and the dashboard a reviewer opens
  against it, which is why a flight should record a screenshot per cohort rather than a sample.

## Running it

```sh
node --test --test-timeout=180000 test/mission-design.test.mjs   # stubs 0/12, reference 12/12, mutation 2/12
node scripts/mission-benchmark.mjs --real --missions=signal-open --configs=stock-eight --repeats=1
```

The mission id is `signal-open`; it shares the `analytics` domain with `signal-analytics` and
dispatches on its own id.
