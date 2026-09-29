---
status: accepted
decision_digest: 5396d8d5652eaa38
amended: 2026-09-29
relates_to: 0004, 0007, 0008, 0009, 0010, 0013
---

# Stow owns portable working storage; execution remains caller-owned

## Context

The product exploration expanded from portable storage into an agent runner and
sandbox. The user has explicitly returned the product to the storage boundary.
Existing storage, workspace and checkpoint machinery supports that direction;
building an execution framework is not a prerequisite for an agent to use it.

The assessment and continuity experiment at revision `5485a36` established useful
storage behavior and specific defects. They did not demonstrate a Stow executor,
fresh-model recovery, cross-host execution or process containment.

## Decision

Stow is portable working storage for agents, tools, applications and tests. It owns
declared input preparation, supported filesystem/object access, workspace identity,
verified checkpoints, diff/restore, export/adoption, storage retention and cleanup.
The native server and its scoped child-process lifecycle remain storage delivery
mechanisms; this decision does not remove the existing scoped S3 session APIs.

Callers own agent and model selection, process execution, tool orchestration,
turn detection, writer quiescence, execution credentials, cancellation and sandbox
resource/network enforcement. An external runtime may supply those functions.

Checkpointing after each turn is an optional integration: the caller reaches a safe
boundary, saves any selected context, requests a checkpoint through existing Stow
operations, and records success only after Stow publishes it. Stow does not infer a
turn from file inactivity, guarantee arbitrary external writers have stopped, or
interpret a saved checkpoint as successful task execution. Existing changed-tree
refusal and storage limits stay in force. The prior completed checkpoint remains
the recovery point if capture fails.

The first integration may carry task briefs/progress as ordinary declared files.
Caller identifiers are opaque provenance, not Stow execution identities. A typed
metadata extension requires a separate schema, size/sensitivity limits and explicit
version compatibility before implementation. It must use existing checkpoint and
archive machinery rather than introduce a second state store or turn registry.

Workspace file checkpoints and S3 object snapshots have different contracts.
Metadata preservation, source Git identity/base acquisition, deletions and supported
platform behavior must be specified and verified for a portable workflow; a copied
directory alone is not proof of all of them. Local workspace references still name
a local registry; explicit export/adoption materializes another workspace.

### Narrowing ADR 0013

ADR 0013's distinction between task, durable workspace, execution attempt and
artifact remains useful vocabulary for a future execution design. Its Stow-owned
TaskSpec schema, attempt IDs/records/state machine, executor and mandatory attempt
history are deferred. They are not requirements for storage or a checkpoint adapter.
The existing input-preparation manifest is not the deferred execution TaskSpec.
Reactivating an execution layer requires a new explicit product decision supported
by a demonstrated consumer need.

### Scope and ordering

`docs/plan.md` is the single implementation work order. The storage milestone is
defined in `docs/portable-agent-workspace-goal.md`; specialist documents contribute
technical details but do not schedule parallel product expansions.

The planning inventory and carry-forward register live in `docs/planning-index.md`.
This scheduling decision supersedes older references to a “plan of record,”
including ADR 0010's reference to the environment implementation plan. Retiring
those work orders leaves their accepted enforcement and storage decisions in force;
their remaining obligations are tracked by the current plan's S0–S4 item IDs.

The active work is storage correctness and compatibility, coherent directory/S3
access, portable state, installability, and evidence from a thin caller-owned agent
integration and an S3 fixture workflow. A Stow agent runner, sandbox backend, model
broker, hosted scheduler, automatic process-memory capture and resource-allocation
API are outside the current plan. Arbitrary edge execution is not a storage claim.

## Consequences

- Extend the existing Go runtime, workspace registry, capture and archive paths;
  language wrappers remain thin clients of the same contracts.
- A real agent continuation demonstration is evidence for the storage integration,
  not a requirement for Stow to own the runner's process or model state.
- Storage/API permissions and quotas retain their documented boundaries. Ordinary
  host filesystem writes and network access need external enforcement.
- Planning changes do not implement an API, fix observed defects, or certify a
  platform. Tests and release evidence remain revision-specific.

## Amendments

- 2026-09-29: Accepted from the user's explicit storage-first product decision;
  narrows ADR 0013's execution obligations and defers the work-session proposal.
- 2026-09-29: Reconciled all repository planning queues into the canonical plan;
  clarified that older scheduling references are historical while accepted
  enforcement/storage decisions remain in force.
