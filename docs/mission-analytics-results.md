# Signal: an eight-agent fleet builds a site analytics platform

Flown 2026-10-22. `artifacts/mission-flight-8ce2fc74-afc2-403d-af51-5c3cd8aa0dc5`. Four cohorts,
32 actors, two cheap models, one mission, one repeat, a 30-minute cap. **$2.72 and 12.1 M tokens
all in**, prices as the harness read them from the local catalog at start.

The [mission](mission-signal.md) is a first-party, Clarity-class site analytics platform: one
small tag, an ingest, a store, and an owner dashboard. Eight workstreams, one per actor. The judge
replays a scripted visitor session through the submission's own tag logic and checks the analytics
against figures computed independently from that script.

## Result

| Cohort | Checks as flown | **Re-graded** | Tokens | Cost | Wall |
| --- | ---: | ---: | ---: | ---: | ---: |
| stock-eight · DeepSeek V4 Flash | 23/27 | **27/27** | 1.47 M | $1.11 | 998 s |
| ingress-eight · DeepSeek V4 Flash | 23/27 | **27/27** | 9.80 M | $1.52 | 791 s |
| stock-eight · GPT-5 Nano | 4/27 | 4/27 | 160 k | $0.04 | 390 s |
| ingress-eight · GPT-5 Nano | 1/27 | 1/27 | 711 k | $0.05 | 127 s |

All 32 actors reported a successful native completion in every cohort, and native success is not
correctness: Nano's cohorts completed and produced almost nothing.

**An eight-agent fleet of a cheap model built the platform to spec, twice, in thirteen and sixteen
minutes.** The fenced cohort scored the same as the unfenced one for **6.7× the tokens and 37% more
money** — the same direction the repository's earlier studies found, and the clearest number here.

Where Nano failed, the trace says why: it left `tag/quality.mjs`, `tag/recorder.mjs`,
`ingest/handler.mjs` and `ingest/store.mjs` at seeded-stub size while writing `app.mjs` and
`tag/batch.mjs` properly. That is a coordination outcome, not a random one.

## The judge was wrong four times, and the first number was mine

The harness recorded 23/27 for both V4 Flash cohorts. All four failures were defects in the judge:

1. **An assertion that contradicted its own spec.** `tag-config-parse` required `maxEvents === 50`
   while the seeded tag carries `data-max-events: 3` and the contract says the attribute overrides
   the default. The submission returned 3, which is correct.
2. **A diagnostic that cannot survive isolation.** `tag-config-refusal` matched the refusal's
   message text, and the isolated invocation flattens the error object. The submission refused
   correctly and was failed for the wording.
3. **An ambiguity I created and then resolved the wrong way.** The contract said a handler returns
   `{status,headers,body}` and never said whether `body` is a string or an object. The submission
   returned the JSON string a real HTTP handler returns; the judge read it as an object.
4. **A helper that was never defined.** The fix for (3) added a tolerant body reader by anchoring
   on a line that no longer matched, so the replacement silently did nothing and the two ingest
   checks threw a `ReferenceError` — which the verifier reports as a failed check, indistinguishable
   from a wrong answer.

The re-grade is retained as `regrade.json` beside the flight. **The flight's own evidence is
unchanged**: it is the record of what ran. Where the two disagree, the judge changed.

Two further lessons are now enforced rather than remembered:

- **A mission fixture is frozen once flown.** Editing the spec text after the flight made all four
  artifacts fail the protected-file gate, which skips the evaluator entirely and reports every
  criterion failed in nineteen milliseconds. `test/mission-freeze.test.mjs` pins the seed hash each
  flown mission was graded against.
- **A re-grade must check that the fixture still matches.** `npm run missions:regrade` recomputes
  the seed hash and refuses to present a re-grade as meaningful when it does not.

I also clobbered my own rescue once: the dry-run grader seeded stubs *into* whatever root it was
handed, which is exactly the wrong thing to hand it an artifact for. It now grades without writing
when given a root.

## What was checked by something other than the judge

The dashboard the fleet rendered was opened in a real Chrome and read back through the
accessibility tree. It shows what an owner would ask for, and the figures match the expectations
computed from the session script:

```
Chester Hill Solutions — 1 sessions · 3 pageviews · 2 errors
Path       Views  Engagement  Rage  Dead  Errors
/          1      4.2s        4     5     0
/checkout  1      6.2s        0     0     2
/pricing   1      1.6s        0     0     0
Scroll depth: 25% (1) 50% (1) 75% (1)
Errors: Cannot read properties of undefined (reading "total") ×2
```

The scripted visitor scrolls to 0.55 on the home page and 0.8 on pricing; milestones 25, 50 and 75
are reached and 100 is not. It rage-clicks a dead button four times, and the five signalless clicks
are five dead clicks. It throws the same error twice and the panel counts two. None of that is the
submission's opinion of itself.

## What this does not establish

- **No frontier comparison, and no claim about it.** Two cheap models, one mission, one repeat. The
  question the whole line of work started from — whether coordination lets a cheap model reach what
  a frontier model reaches alone — needs the frontier arm, and this flight does not have one.
- **The tag was never run in a browser.** The verifier's isolation has no DOM and no network, so the
  mission's contracts are pure functions and the client-side claim is not exercised end to end. The
  dashboard render above is the only live-browser check, and it is mine rather than the harness's.
- **One mission, one spec, one author.** The judge, the seeded site and the expectations are all
  mine. A submission can only be as well measured as the contract it was given, and four of this
  judge's twenty-seven checks were wrong on the first pass.
- **The artifacts are graded, not the process.** Nothing here says the fleet's eight agents
  coordinated well, only that the artifact they produced satisfies the contract. The fence's own
  trace — 74 decisions in the V4 Flash ingress cohort — is retained and unread.
- **"Complete HTML string" was ambiguous.** The dashboard renders a fragment and links no
  stylesheet, so it is unstyled unless a page links it. The judge accepted the fragment because the
  contract did not say which it wanted.
