# DeepSeek V4.1 native checkout pilot

The user-selected `opencode/deepseek-v4.1-flash` comparison completed all nine
preassigned cohorts and 36 actors. Current product rules and block checkouts each
produced **2/3 correct missions**; graph checkouts produced **1/3** with substantially
more retries and waiting. This pilot does not establish an overall improvement or
qualify RT-1. The earlier V4 Flash provider failures remain separate evidence.

The fresh run is retained in `artifacts/checkout-native-deepseek41-v1`, including
the frozen protocol, assignments, source snapshots, every candidate and decision,
independent grading records, sanitized native usage, final sources and summary.
`analysis.json` derives the following totals from `results.json`.

| Arm | Correct within budget | Median settlement | Native turns | Published actors | Reported cost, three cohorts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current product rules | 2/3 | 133.5 s | 12 | 12/12 | $0.2251 |
| Block checkouts | 2/3 | 85.3 s | 12 | 12/12 | $0.2154 |
| Graph checkouts | 1/3 | 266.0 s | 30 | 10/12 | $0.3585 |

Settlement includes setup, model work, publication, intermediate grading and confirmed
runtime stop; it excludes final post-stop grading. These medians include incorrect
missions, so they are not time-to-correctness estimates. First observed correct
publication was 92.4/132.9 seconds for the two correct current trials, 62.1/105.8
seconds for blocks, and 265.1 seconds for graph. Every cohort settled within the
ten-minute deadline. All nine final trees passed the 16 public legacy checks; only
five passed all 14 held acceptance groups.

All 54 comparative native turns reported success, but native success did not imply
publication or whole-mission correctness. The second current trial failed the
complete-stock-report check. The second block trial failed missing-stock handling.
Both had all four actors publish on their first turn. No held acceptance feedback
or manual rescue was supplied.

Graph incurred nine changed-base refusals, nine unresolved-dependency refusals and
two scope-expansion refusals. Its recorded aggregate actor waiting was 672.6 seconds,
which overlaps across actors and must not be treated as elapsed cohort time. Ordinary
calls such as `Math.min`, `.map`, `.reduce` and `.push`, and locally introduced helpers,
exceeded the bounded parser's evidence coverage. Agents sometimes adapted their code
after the actual refusal. Two exhausted their three-turn allowance by adding helpers
outside their original grants: `src/inventory.mjs#aggregate` in repeat two and
`src/storage.mjs#assertOrderRecord` in repeat three. V1 has no scope expansion, so those
candidates did not land. The published graph trees also failed held behavior checks;
refused publication alone does not explain every failed group.

Block trials were faster in all three matched repeats, but three samples of one mission
are insufficient to attribute that difference to the mechanism. Roles modified separate
files with a fully specified shared contract, and current/block encountered no recorded
submission conflicts. The experiment therefore demonstrates no recovered interference
outcome for graph. It measures one small synthetic mission on one model/host; it does
not establish repository-scale productivity, durable isolation or arbitrary JavaScript
coverage. The earlier [deterministic comparison](checkout-comparison-results.md) remains
a different mission set and must not be pooled with these model trials.

All comparative sessions recorded the exact requested model in final native SQLite
totals. The totals cover 12 sessions per arm, including their retries; cost is provider
reported, not a billing reconciliation. Preflight adds two successful sessions and
$0.002319852 separately. Live closed-step observations and cumulative database totals
are separate sources and must not be added together. Streams reported no sequence gaps,
event omissions or missing closed-step usage; their live-only transport cannot prove
that every upstream event was exposed. Initial permission categories are recorded, but
complete issued-grant receipts and every waiting poll are not retained. This limits
grant auditing independently of final artifact grading.

All owned servers stopped, including preflight. The post-run fingerprint audit confirmed
all 12 recorded implementation hashes and source, mission, public behavior and contract
hashes. That list covers the declared files, not every transitive runtime dependency.
No parser, checker, mission, arm or retry budget changed during the admitted campaign.

The local working-copy/submission bridge uses four actual separate directories per
cohort. All initial native prompts admit together; observed native execution peak was
four in every cohort. This is concurrent private preparation, not four simultaneous
authorized graph publications. Publication requires the selected arm's admitted write
path. A deferred grant with changed bytes forces another native edit turn against the
issued base. Native file tools have external-directory, shell/package/subagent and
protected-file restrictions. The bridge trusts local identity, clock and in-memory
state; directory naming and tool policy do not establish OS filesystem privacy or an
authenticated durable product boundary.

The mission covers mixed-tax order pricing, partial inventory/backorders, compatible
v1/v2 persistence and checkout/receipt/report integration across 16 synthetic modules.
Its independent reference passes all acceptance and legacy checks; the seed passes
legacy checks and fails the new goal. Expected values stay in the parent grader.
Generated code executes under Node 26 read-only permissions with network, filesystem
writes and child-process creation denied. Three model-free regressions check publication
gating, changed-base handling, reference qualification and permission isolation. The
full Node 26 suite passed **845/845**, retained in
`artifacts/checkout-native-node26-tests.tap` before admission.

The next work identified by this pilot was explicit grant expansion for introduced helpers/dependencies,
and improved binding coverage with adversarial qualification. Keep this campaign fixed;
evaluate those changes under a fresh protocol with varied dependency-sensitive missions
before claiming useful benefit. Faster block trials alone do not justify deployment.
That [prototype increment is now qualified separately](checkout-expansion-results.md);
its reconstructed helper checks and deterministic results do not change this native
campaign's scores. The [fresh varied-mission study](checkout-varied-results.md) has now
completed separately: current 3/9, blocks 1/9, graph 2/9, with no overall improvement.

## Retained V4 Flash preflight failures

Before the user selected V4.1, three fresh V4 Flash preflight attempts were retained in
`artifacts/checkout-native-deepseek-v1`, `v2` and `v3`, each with its planned nine-cohort/
36-role manifest. Of six actual preflight sessions, one edited its private marker;
five failed with `provider.invalid-request`, HTTP 404, before tokens were recorded.
No comparative cohort was admitted in those attempts, and all servers stopped.
These are provider/access outcomes, not checkout effectiveness results. Sanitized
error type/status and cumulative model/usage metadata are retained without provider
messages, context, credentials or generated prose.

Automatic approval review initially rejected the real run because it interpreted the
payload as private repository content exported externally. The provenance check in
`artifacts/checkout-native-payload-proof-v1.json` established that all 16 modules exactly
match the agent-created synthetic template. Only that fixture, synthetic public tests
and mission instructions enter model copies; product/coordination code runs locally.
The subsequent synthetic-only execution was approved. Credentials are used only for
normal OpenCode authentication. Saved model settings and deployed product code were
not changed.

```sh
npm run checkout:agents -- --real --model=deepseek-v4.1-flash \
  --python=/private/tmp/ingress-graphify-venv/bin/python --repo=fixtures/checkout-lab
```

Real trials remain opt-in. Every run uses a fresh ignored artifact directory and a
two-directory runtime preflight before comparative admission. `--plan` instead of
`--real` writes assignments without credentials or model calls. See the
[frozen protocol and model amendment](checkout-comparison-protocol.md).
