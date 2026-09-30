# OpenCode integration model

Decision: keep GangCode as the collaboration product and integrate with native
OpenCode hooks. Start with one scoped native host serving multiple sessions; keep
the execution host replaceable. A fork is not justified by the evidence so far.
This is a design and compatibility result, not a completed squad-runtime migration.

## What was verified

The installed launcher identifies itself as OpenCode 2.0.16. Research used pinned
source commit 3a103fe0aff726a4edc7492f03f7b88195d9e4c9; a version string alone does
not prove that the installed binary is identical to that source. Current V2
plugin/SDK documentation supports the broad interfaces; V1 examples differ.

The opt-in installed-binary diagnostic runs two native sessions on one host with a
scripted loopback chat-completions provider. It holds both initial requests until
both arrive, advances a synthetic collaboration revision, asks each session to
execute the native read tool, and checks the subsequent model request. Both
sessions completed; before/after read hooks fired; each subsequent provider
request contained exactly one marker matching an independent native-hook session header
at the updated revision.
Plugin cleanup and native-process stop were observed. No real provider credential
was used. The final diagnostic observed four model HTTP requests, all at loopback;
other network traffic is not measured. This qualifies context/tool
plumbing and overlapping requests, not model reasoning or productive speedup.

Run from the repository:

```sh
node scripts/opencode-plugin-smoke.mjs --native-local
```

Requires the installed pinned binary and existing public model catalog. It uses
space-bunny-free's native driver with a fixture credential; observed model HTTP
requests are redirected to loopback by hooks. Routing on a failed plugin load remains
unknown; this fixture is not a global egress isolation test. Evidence contains only
metadata and assertions, not headers, request bodies, model prose or read contents.
The fixture intentionally allows only the advertised read tool. It does not test
arbitrary tools, writes, permission declines, compaction or cancellation.

All development attempts are retained in
[compatibility evidence](opencode-plugin-compatibility.json). The first two
attempts failed before reaching the local provider: the launcher's configured
provider settings did not redirect the prepared request in this environment.
Those requests used a fixture credential; no real credential was read. Their
non-loopback preparation is recorded and their external transport outcome is
unknown. Two subsequent attempts reached loopback but advertised no tools because
the prototype filtered out OpenCode's effective/codemode tool names. Session
success alone was insufficient. The corrected native-read probe passed, followed
by a repeat with explicit assertions. Review found that marker-derived identities
could not independently prove cross-session serialization isolation. A seventh
attempt added a session header from the native HTTP hook, checked marker/header
agreement, bounded diagnostic records and made cleanup failure-safe; all eight
assertions passed. These failures and earlier proof limitations remain retained.

## Product and execution boundary

GangCode owns the workspace, team roster, tasks and human directions; rooms and
last observed locations; dependency/read evidence; subscriptions and bounded
context; task generations; task admission policy; evidence and live view.
OpenCode owns each session's inference loop, providers, tools, permissions,
continuations, compaction and native execution lifecycle.

```text
Human controls / squad supervisor
             |
GangCode task queue, identities, workspace state and context cache
             |                                  ^
      one native host                    file reconciliation
             |
     location-scoped GangCode plugin
             |
     separate OpenCode sessions
       context hook -> provider request
       tool hooks   -> bounded observations
```

Every registered session maps to an explicit workspace/actor/task/generation.
Ignore unregistered sessions; plugin location is not a substitute for the session
location. Native-created child sessions need an explicit registration decision.
A join snapshot includes existing peers, their intentions, last observed ranges,
read bases and coverage. Unknown positions stay unknown. No ownership claims.

## Native seam contracts

| Need | OpenCode seam | Qualification / remaining gap |
| --- | --- | --- |
| Fresh context on every primary turn | session context hook | Installed two-session continuation verified. Source also refreshes retries; retry behavior still needs adapter tests. |
| Initial task and room information | GangCode registration plus initial envelope | Preserve the existing initial contract; the smoke uses synthetic markers, not the full production envelope. |
| Observe tool access | tool execute.before / execute.after | Installed native successful read verified. Tool call carries session, assistant-message and call IDs. Completion is not exact byte attribution. |
| Retain awareness after compaction | separate compaction hook plus subsequent primary injection | Source-supported; untested installed behavior. Current room truth should be rebuilt, not trusted to a historical summary. |
| Human steer / queue | native prompt delivery modes | Source-supported and existing admission receipts; active-task adaptation remains unqualified. |
| Stop one actor | session interrupt followed by settlement | Source-supported; installed shared-host cancellation and admission races need testing. |
| Refuse a stale native tool call | Effect execute.before typed Tool.Error | Source-supported, untested installed. Promise bridge rejection is not the same typed failure channel at this pin. |
| Prevent stale filesystem overwrites | revision-aware mutation mediation | Not established by hook observation or a before check. No guarded-write claim. |

Pinned contracts: [session hooks](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/plugin/src/promise/session.ts),
[tool hooks](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/plugin/src/promise/tool.ts),
[runner](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/core/src/session/runner/llm.ts),
[request preparation](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/core/src/session/model-request.ts).

## Context without message spam

Use the initial task message for assigned work and accepted human direction. Use
the primary context hook for the latest bounded collaboration envelope, including
changes relevant to subscribed files, stale reads and declared dependencies. Put
peer text inside explicitly descriptive, untrusted data; it must not become system
authority merely because the envelope is injected into a system part.

Refresh at every provider boundary, including tool continuations. Keep a stable
prefix and append the changing collaboration section near the end for cache
reuse. Replace the request-local collaboration section rather than accumulating
one historical message per file event. Do not assume it appears in the durable
session context endpoint. Separate hook incorporation, actual provider-bound
serialization, inbox delivery and independently measured adaptation.

Keep callbacks small: lookup an already-compiled per-session snapshot in memory,
record a bounded receipt and return. File reconciliation, dependency propagation
and any optional rapid model decision run outside the hook. Coalesce changes,
index recipients, bound context bytes and report omissions. A broken bridge yields
explicit unknown coverage; it must not quietly present an old revision as current.
Protocol choice is secondary to keeping this path deterministic and bounded.

In shared-host mode use one event subscription and demultiplex by session, rather
than one all-session feed per actor. The current squad launches one process and
listener per actor. Moving to one host removes repeated runtime/catalog/startup
work; it does not speed provider inference. Benchmark startup, dispatch/context
p95, queue lag, process memory and productive outcomes separately.

## Controls need a GangCode admission layer

Steer is consumed at the next eligible model-step boundary. It does not cancel an
in-flight provider request or tool immediately. Queue becomes eligible at an input
boundary; resume:false suppresses waking, but an already-running drain can still
consume that item later. Keep future tasks in GangCode's queue until eligible for
admission. Routine workspace awareness belongs in the context hook.

Use a local control identity including workspace epoch, actor, task generation and
session ID. Reusing a native inbox ID must require an identical payload locally;
native reconciliation does not compare changed text. Human directions retain
priority over any optional advisory decision maker.

On interruption close the actor's admission gate, request session interruption,
and show stopping until settlement is confirmed. Accepted interruption is not a
stopped-writer receipt. Block successor admission during cleanup. A stale control
must be rejected locally before reaching OpenCode: its public session interruption
has no expected-generation argument. Waiting can follow successors, so it cannot
alone establish an execution-specific barrier when new admissions are allowed.

The cohort owns shared-host close. An individual actor cannot kill the host as its
cleanup fallback without stopping peers. If a session cannot settle, report the
cohort-level condition and apply an explicit recovery policy. A bounded pool of
hosts may be useful for failure containment; it must not silently turn a requested
simultaneous cohort into serial batches.

Pinned [admission](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/core/src/session/session.ts),
[inbox](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/core/src/session/inbox.ts),
[execution](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/core/src/session/execution.ts),
[coordinator](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/core/src/session/run-coordinator.ts).

## Hooks do not establish overwrite safety

At this pin Effect execute.before can reject with a typed tool error; the Promise
adapter uses Effect.promise and does not preserve that declared failure channel.
Use and test the Effect route if graceful rejection becomes a requirement. See the pinned [Effect failures](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/plugin/src/effect/tool.ts) and [Promise adapter](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/plugin/src/promise/adapter.ts). The
successful/error after hook is not a universal finally hook: pre-hook rejection,
interruption and defects need separate lifecycle handling.

A before-hook revision check runs outside native mutation locking. An external
writer can modify the file after the check; native locks are process-local.
Shell/MCP/background processes and human editors can also mutate files. Requested
read paths may resolve through fallback, and formatting can follow writes. Later
hash observation cannot automatically prove exact bytes read or written.

For coordination retain this uncertainty. If overwrite prevention becomes a hard
requirement, define a version-aware mutation interface and prove its atomicity and
coverage across all allowed write paths. That is independent of file ownership.

## Embedded SDK versus fork

The published @opencode/sdk 2.0.16 exists and hosts core/server through an in-memory
HTTP router with no listener. Its pinned build targets Node ESM and includes a
Node SQLite implementation; the published dependency closure has not been imported
or exercised here. This is an optional host implementation, not a required first
migration. It brings OpenCode dependencies, storage choices and host failure into
GangCode's process. Prove exact platform/runtime startup and close before adopting.

A fork needs a reproducible required contract that supported hooks, caller-side
admission, dedicated sessions and bounded hosting cannot satisfy. Candidates
include generation-specific cancellation under unavoidable external admissions or
complete atomic write mediation unavailable at the native seam. First consider a
narrow upstream extension. Long inference turns and an observer policy bug do not
justify owning the whole harness.

Official [V2 plugin docs](https://opencode.ai/v2/docs/build/plugins/),
[SDK docs](https://opencode.ai/v2/docs/build/sdk/),
[published SDK metadata](https://registry.npmjs.org/@opencode%2fsdk/2.0.16).

## Next implementation slices and gates

1. Production plugin bridge: bind registered sessions to existing workspace state;
   inject the real bounded envelope at each primary boundary; capture tool metadata
   without raw outputs; keep initial join semantics. Test unrelated-session isolation,
   omissions, bridge disconnect, retry refresh and compaction.
2. Shared host ownership and one demultiplexed event feed. Reuse the existing client,
   observer and evidence vocabulary. Test two concurrent sessions, interrupt one while
   the other continues, blocked finalizer/cleanup, reconnect gaps and host failure.
3. Control admission state machine. Prove steer before original task completion;
   queue without preemption; idle/active resume:false behavior; stale-generation
   rejection; same-ID changed-payload rejection; successor admission blocked during
   stop. Observe partial effects honestly.
4. Repeat simultaneous 16 builders using the selected real model, retaining every
   assigned outcome. Compare startup/context cost and paired useful-work results;
   no concurrency cap disguised as scale. SDK embedding remains a separate optional
   compatibility arm. Reliable benefit and guarded-write qualification remain open.
