# Realtime collaboration plan review and engineering handover

**Date:** 2026-09-29. **Status:** second documentation review; RT-0 implementation is now under qualification; later implementation/qualification
remain open. Reviewed the product, engineering, evaluation and canonical
plans against CONTEXT, ADR 0014 and existing callers. Three independent reviewers
examined causal coordination, harness/UI receipts, and product/evaluation scope.

## 1. Plan validation summary

**Adjust before implementation; adjustments incorporated into the plans.** The latest
first product is continuous native activity/change observation feeding maintained state
and bounded decisions. The earlier roadmap required a shared editor before testing that
value. RT-0 now proves observation and shadow evidence; RT-1 tests useful awareness and
steering. Guarded editing remains a separate conditional expansion. Collaboration stays
caller-owned under [ADR 0014](reference/stow-storage-boundary.md).

This review closes specification gaps, not runtime gates. Native event coverage,
first-join/pre-read delivery, actual steering, stop settlement, useful coordination and
optional Jev benefit still require measured evidence.

Subsequent user direction places the product in its own repository. The
[repository boundary](realtime-repository-boundary.md) defines extraction before RT-0;
these plans have transferred to this repository. Stow is an optional public storage
integration, with collaboration tests/builds and RT ownership separate.

## 2. What the plan already covers well

The plan rejects claims, keeps models off presence/edit/control delivery paths, treats
peer prose as evidence and separates queued work from active steering. Existing join
barriers, staged patches, reverted-range checks, durability ordering, semantic retry
identity, immutable capture cuts and restore admission epochs remain valuable for the
later guarded profile. Independent correctness checks and awareness-disabled comparisons
are appropriate; classifier confidence is not treated as correctness probability.

Earlier review fixes remain **proposed contracts**. None becomes implemented because
this review retains it. Historical prototype evidence remains intact.

## 3. Gaps, conflicts, or redundancies to fix

The following findings are addressed in the revised specification. Their tests are
engineering handover requirements, with P1 issues blocking the relevant runtime claim.

1. **[P1] First-product/roadmap mismatch.** Product delivery and engineering RT-0 still
   required browser/CRDT/mediated editing while observation was optional support.
   **Adjustment:** RT-0 observes native agents, maintains state and scores shadow decisions;
   RT-1 evaluates useful delivery/steering. Editor/runtime/codec work moves to conditional
   RT-2. Define observer and guarded capabilities separately: observing native writes
   cannot guarantee stale-write refusal, durable acceptance or immediate mutation fencing.
   **Verify:** one-harness observation/value evidence without editor infrastructure;
   guarded safety claims require the separate RT-2 suite.

2. **[P1] Human direction could lose to a stale same-generation decision/proposal.**
   Engineering checked generation and file revisions, while native steer can preserve
   both. **Adjustment:** bind decisions/guarded proposals to task, instruction, intention,
   execution/context and evidence versions. Human steer acceptance supersedes pending
   automatic decisions immediately; delivery establishes eligible new context. Recheck at
   admission. **Verify:** hold a classifier response and old-step patch, steer without
   changing code/generation, then release both. No obsolete action or guarded patch lands.
   Native observer writes remain outside this enforceable mutation boundary.

3. **[P1] Mixed streams lacked a causal state reducer.** OTel and Jev sections described
   inputs without specifying current-state construction. **Adjustment:** version source
   observations, coverage, source/receive times and correlation; preserve authoritative
   native/guarded receipts separately from inferred activity. Freeze immutable evidence
   cuts. Detect gaps and reconcile; late old-run observations never regress state or
   manufacture read/stop proof. **Verify:** reorder/duplicate/drop spans/events across a
   replacement execution and watcher overflow; show uncertainty until bounded catch-up.

4. **[P1] Intention acquisition was unspecified.** A presence field alone does not tell
   the product what the agent means to do. **Adjustment:** authenticated `set_intention`
   or equivalent hook with task/instruction revision, declaration version and expiry.
   Assigned goals, declarations and inferred activity remain distinct. Explicit join or
   a verified pre-read hook is necessary for the first-message contract. **Verify:** queued
   work does not change active intention; late telemetry cannot revive an expired one;
   absent declarations/locations remain unknown; a completed read span is not join proof.

5. **[P1] Parser lag could permanently lose a dependency change.** Retaining old edges
   cannot catch changes through an edge not yet discovered. **Adjustment:** processed-through
   graph/configuration watermarks and catch-up reconcile newly installed edges with
   producer causes. Dirty/incomplete graphs cannot certify unaffected work. **Verify:**
   delay parsing across a new consumer import and producer edit; require missed-cause
   delivery and guarded stale-patch refusal. Repeat after alias/package resolution changes.

6. **[P1] Read-set protection omitted inherited/injected context.** A resumed agent can
   use an old contract without a new `read_file`. **Adjustment:** register revision-linked
   task inputs and inherited assumptions; unknown bases require relevant refresh for
   guarded admission. Separate considered self-report from verified refresh/unchanged
   evidence. **Verify:** seed an old dependency in session context and attempt a
   destination-only guarded patch without rereading; an empty new-task read set cannot
   bypass freshness. Coverage limits remain explicit.

7. **[P1] Ready/check currency could survive later edits.** Named revision checks existed
   without an automatic change-group state transition. **Adjustment:** monotonically
   versioned required-file manifests; authenticated compare-and-set ready declarations;
   later relevant contributions invalidate effective readiness/check currency. **Verify:**
   deliver a passing check/ready result for version 3 after version 4's edit. It stays
   historical and cannot clear the consumer's current refresh requirement.

8. **[P2] Continuous inference/actuation lacked bounded admission and crash reconciliation.**
   Notification budgets do not bound classifier storms. **Adjustment:** one in-flight
   evaluation per task, one coalesced pending cut, semantic deduplication, total deadlines
   including retries, cost budgets and deterministic composition of independent answers.
   Persist decision/control identity and reconcile uncertain native admission before retry.
   Enumerate no-action/notify/refresh/steer-current-task/ask-human; disable automatic
   interruption/new tasks initially. **Verify:** a duplicate-source flood and crash after
   control acceptance produce bounded calls and no duplicate/stale control.

9. **[P2] Existing receipt names overstate evidence.** The coordinator records listener
   callbacks as received at [lines 54–58](reference/stow-source-record.md)
   and marks messages applied after an output-changing turn at
   [lines 123–132](reference/stow-source-record.md).
   **Adjustment:** reuse routing mechanics, not their interpretation as model adaptation.
   New UI separates routed, accepted, context-delivered, considered, refreshed and verified
   adaptation. **Verify:** queued-but-never-run and delivered-but-ignored reports cannot
   count as applied adaptation; unrelated output changes do not establish consideration.

10. **[P2] Observation configuration/freshness is not qualified.**
    [Server lines 7–23](reference/stow-source-record.md) strip most `OPENCODE_*`
    settings, copy other ambient variables and synchronously probe version on every start.
    **Adjustment:** explicit dedicated-profile plugin/OTLP routing, child isolation and
    async identity-bound pin verification. Pin the observer release and test exact headless
    binary compatibility; use native events first and measure export age. Metadata-only
    export must be proven, not inferred from a prompt-log flag. **Verify:** intended
    settings reach only the experiment child, unrelated routing is excluded, credentials
    stay host-side, and collector/slow-probe failure does not stall controls. Community
    [plugin documentation](https://github.com/DEVtheOPS/opencode-plugin-otel) is candidate
    evidence, not a runtime compatibility receipt.

11. **[P2] Trial exclusion could bias results.** Earlier scoring excluded missed read
    barriers; steering can itself change whether a read happens. **Adjustment:** freeze
    apparatus eligibility before assignment, retain every assigned run in primary results,
    and show opportunity-qualified adaptation separately. Add delayed/missing/weakly
    correlated observations and stale decision/group/graph schedules. **Verify:** counts
    reconcile by arm, missing coverage is not discarded, and held-out success uses fields
    actually available in the selected harness.

12. **[P2] Advancement conflated product and classifier success.** **Adjustment:** separate
    trustworthy observation, deterministic awareness benefit, incremental Jev benefit and
    voluntary reuse gates. Pilot-derived numeric limits/sample sizes freeze before each
    qualification; a failed Jev result need not discard useful routing. **Verify:** record
    continue/narrow/stop decisions including cost/churn/setup burden, not just task success.

## 4. Existing code/product references to reuse or extend

| Touchpoint | Reuse / boundary |
| --- | --- |
| [ADR 0014](reference/stow-storage-boundary.md), [canonical plan](plan.md) | Storage/caller boundary and one work-order authority |
| [Coordinator lines 64–87](reference/stow-source-record.md) | Isolated processes, credentials and `onAdmitted`; new scheduler does not inherit exclusive outputs |
| [Room](reference/stow-source-record.md) | Participant/subscription/report identities; old report-file watcher is not continuous workspace observation |
| [Dashboard](reference/stow-source-record.md) | Artifact confinement/rendering; receipt labels need new semantics |
| [OpenCode helper](reference/stow-source-record.md) | Authenticated requests, admission identity and session checks; original footer/post-execution validator stays in the old profile |
| [Server helper](reference/stow-source-record.md) | Dedicated HOME/XDG and exact pin; planned async verification/config path is not implemented |
| [Workspace file helper](reference/stow-source-record.md) | Initial/reconciliation scans; avoid full hashing for every event |
| [Controller](reference/stow-source-record.md), [native storage](reference/stow-source-record.md), [workspace facade](reference/stow-source-record.md) | Capture request identity, bounded retry, resolve and restore; no duplicate storage registry |

## 5. API impact and validation notes

**No core Go/storage API or checkpoint schema change is required.** Version caller
observation, state, decision, control, intention and change-manifest records separately.
Native log/control APIs must be qualified against the exact harness binary; admission
is not delivery or adaptation. Tool-only participation cannot claim native active control.

Observer and guarded authority are distinct. Moving to guarded editing requires writer
quiescence, verified baseline import and adapter admission changes; watcher output cannot
silently become a second document authority. Retain staged mutation validation, semantic
retry hashes, bounded state, immutable exports and restore epochs for that later profile.
Optional Jev has no authority beyond the assigned task; current evidence and human direction
are revalidated before actuation. Planning installed no plugin or model dependency.

## 6. Final adjusted plan, summarized

1. **RT-0:** native observation, revisioned state and shadow decisions with coverage/fault
   evidence and a continue/narrow/stop gate; use the existing caller runtime/model.
2. **RT-1:** presence-first awareness, truthful intentions and bounded native steering;
   compare awareness-off/on, then optional Jev under equal safeguards/control opportunities.
3. **RT-2:** conditionally add guarded shared editing/durability, proving prevention and
   fencing separately; measure the actual workload before runtime/codec expansion.
4. **RT-3:** dependency parsing/catch-up, inherited-context coverage, truthful readiness
   and qualified mixed-harness/human participation.
5. **RT-4–RT-6:** full steer/queue/interrupt UX and settlement, immutable Stow snapshots,
   then authenticated remote qualification. Adopt only after independent repeat-use evidence.

Storage remains Go. Continuous ingestion uses code; actionable decisions may use rules
or qualified Jev. Language and transport serve responsiveness and maintenance, with no
requirement to build multiple stacks before measuring collaboration value.

## 7. Handover items for engineering, enumerated

1. **New collaboration repository / RT-0 integration lead:** transfer plans and port
   applicable caller primitives under the repository boundary; implement observation/reducer/ledger
   under engineering §6; verify adverse source schedules and immutable evidence cuts.
2. **OpenCode server/adapter lead:** qualify exact log/control receipts, explicit child
   configuration and nonblocking pin checks; preserve affected existing caller regressions.
3. **Presence/UI lead / RT-1:** implement join/intention lifecycle and truthful evidence
   states; test missing locations, queued reports and ignored notifications.
4. **Decision/control lead / RT-1:** implement bounded catalog/admission/recovery; test
   same-generation human precedence, contradictory answers, floods and lost control replies.
5. **Evaluation lead:** preserve all assigned trials, freeze coverage/benefit/overhead
   thresholds after the diagnostic pilot, and report independent awareness/Jev/adoption gates.
6. **Document lead / conditional RT-2:** prove quiesced authority transfer, native-write
   denial, context/range checks, durability, retry identity and crash recovery.
7. **Dependency/harness lead / RT-3:** implement graph catch-up, inherited input bases and
   versioned group invalidation; qualify native Codex/Pi and tool-only hosts independently.
8. **Storage/remote leads / RT-5–RT-6:** reuse existing capture/resolve/restore against
   immutable bytes; qualify remote roles/path/session boundaries and latency separately.
9. **Plan owner:** keep the canonical RT status current. The [evaluation protocol](realtime-collaboration-evaluation.md)
   has not run; documentation agreement does not certify useful coordination or compatibility.
