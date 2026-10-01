# Collaboration repository boundary

**Date:** 2026-09-29. **Status:** local standalone repository created as `agent-collaboration`; no remote created or publication performed.
Implements the user's direction that collaboration should have its own repository.
This repository now owns the RT plan. Stow retains source evidence and a pointer.

## Ownership

GangCode owns native harness observation, participant presence/intentions, agent
read tracking, semantic dependency impact, relevant context, decisions, scheduling,
harness adapters, controls, shared editing, UI and its evaluation apparatus. It has
its own build, lockfile, tests, CI and release decisions.

Stow owns storage identity, supported guarded-save admission, saved artifacts,
retention, transfer and recovery. Its accepted expansion also owns generic content
reconciliation, durable storage subscriptions/replay, immutable ready reports and
optional webhook delivery; those notification capabilities remain planned. GangCode
consumes qualified storage facts and decides what they mean for active work.

The current boundary is reconciled in the [ownership/integration reference](../../stow/docs/gangcode-stow-boundary.md)
and Stow's [consolidated plan](../../stow/docs/storage-foundation-plan.md). The
[original ADR 0014 snapshot](reference/stow-storage-boundary.md) remains dated
provenance; later Stow ADRs 0015/0016 extend it. This boundary update schedules no
runtime migration and upgrades no capability claim.

Stow is a storage integration, not a prerequisite for attaching to an existing
workspace or testing RT-0–RT-1. Ordinary workspace directories and deterministic
fixtures suffice for the observation/awareness loop. Immutable Stow checkpoint
integration follows at RT-5, through a bounded storage-adapter contract.

## Allowed dependency boundary

- Use Stow's documented CLI or public package exports, including
  `@chester-hill-solutions/stow-s3/workspace`, for supported storage operations.
- Pin the consumed version/artifact. v0.2.0 is tagged and published to public npmjs
  with all four platform carriers; a clean install of it has not been verified end to
  end, so treat it as installable but not certified. The 0.3.0 working tree is a
  development candidate and unpublished; development may install an explicitly
  built/packed artifact without assuming registry availability. Do not depend on
  sibling checkout layout or `src`/`dist` internal paths at runtime.
- Keep harness process supervision in the collaboration product. The existing
  `examples/opencode/server.mjs` imports internal `dist/start.js` for `stopChild`;
  that import cannot cross the new package boundary. Implement/port caller-owned
  supervision with provenance and its termination tests, or use a qualified harness
  lifecycle API. Do not expose a storage-internal helper merely for migration.
- GangCode owns the meaning and lifecycle of task, presence, context and control
  state; selected versioned artifacts may be persisted through Stow. Do not duplicate
  Stow's storage notification/save receipts or interpret its private registry.
  Provider credentials, live process handles and telemetry endpoint secrets remain
  host-local and never enter portable snapshots.
- Keep ordinary-directory observation as a standalone fallback. When a qualified
  Stow notification profile is integrated, use its journal as the storage-change
  authority and retain native harness evidence separately. A delivery receipt does
  not prove context injection, provider consumption or useful adaptation.
- The current native object MCP profile protects participating object saves, not
  native workspace filesystem edits. Guarded code editing needs a qualified tool
  path and workspace/document semantics; attaching MCP supplies no automatic guard.
- Stow's embedded/WASM TypeScript binding accepts `ifMatch`/`ifNoneMatch` on
  `putObject` and refuses with `conditional_write_unsupported` when the host lacks
  the capability. That qualifies *object* conditional writes, not the richer
  managed-save contract: there are still no `ReadForSave`/`SaveObject` resource
  observations, and no committed/not-committed/unknown outcomes available to this
  product. Routing native `write`/`edit` through it would still not be conflict-safe.

No new generic harness package, plugin publication, hosted service or language
migration is required to establish this repository boundary.

## Extraction record and acceptance

1. Established the separately named local repository with a minimal
   manifest, lockfile, README and independent test command; no nested Git repository
   inside the Stow checkout. Remote creation/publication is a separate action.
2. Transferred the product, engineering, evaluation and review plans as this
   repository's authoritative RT documents. Carry the relevant ADR boundary rationale
   and dated source references; repair relative links to Stow documents/code.
3. Ported applicable caller primitives: authenticated OpenCode requests, admission
   identity, scoped process state, validated configuration, small local persistence
   and fixture verification. Preserve licenses and record exact source hashes/revision
   provenance, including uncommitted source where applicable. Do not inherit claims,
   exclusive output prompts, post-turn receipts as adaptation proof or the old native
   writer profile's restricted-tool assumptions.
4. Leave the original prototype and storage-focused OpenCode example in Stow as dated
   evidence/use cases. Cross-repository fixes to retained helpers need explicit tests;
   do not maintain two independently authoritative versions of the new RT product.
5. Start the observer on an ordinary fixture directory using the chosen OpenCode model.
   Stow integration is isolated/optional; a clean checkout must run core deterministic
   tests without a sibling Stow checkout or Go build.
6. After transfer, replace Stow's active RT detail with an external project pointer and
   retained historical review/evidence notice. Storage S0–S4 work remains authoritative
   here; collaboration progress/decisions move to the new repository.

## Acceptance

A clean collaboration checkout can install, test and observe its fixture without
Stow's source tree. Optional storage contract tests consume only the pinned public
artifact/CLI and check request identity, uncertain capture reconciliation and restore
behavior. Import checks reject private/sibling Stow paths. Both repositories have one
clear owner for their plans and release gates. No credentials or user workspace data
are copied as part of extraction.
