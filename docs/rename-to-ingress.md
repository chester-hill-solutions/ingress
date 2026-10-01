# Rename: GangCode to Ingress

**Date:** 2026-10-01. **Branch:** `rename/ingress`.

The product was renamed from GangCode to Ingress. The name referred to the participating
group; the product's actual subject is admission — an agent picks up a file, is told its
current state, and must declare intent before proceeding. Ingress names that mechanism.

The experimental axis is unchanged and was deliberately preserved: treated configurations
are `ingress-*` and baselines are `stock-*`. That axis — many coordinating agents against an
independent baseline — is the study design, not branding.

## What was renamed

| Surface | Change |
|---|---|
| `fixtures/`, `test/` filenames | `gangcode*.mjs` → `ingress*.mjs` (7 files, via `git mv`) |
| `seedGangCode` / `verifyGangCode` / `verifyGangCodeExtensions` | `seedIngress` / `verifyIngress` / `verifyIngressExtensions` |
| `gangCodeSpec` / `gangCodeTasks` / `gangCodeIntegrationTask` | `ingressSpec` / `ingressTasks` / `ingressIntegrationTask` |
| Configuration labels | `gang-pair`, `gang-four`, `gang-eight`, `gang-two`, `gang-mixed`, `gang-4`, `gang-8` → `ingress-*` |
| `structural_gangcode_plugin_absence` | `structural_ingress_plugin_absence` |
| Blind-review redaction pattern | gained `ingress-*`; kept `builder-reviewer` |
| `system: 'gangcode'` | `system: 'ingress'` |
| Prose in `docs/`, `README.md`, `AGENTS.md`, demo artifact | GangCode → Ingress |

## What was deliberately not renamed

**Recorded evidence keeps the name it was recorded under.** These are facts about runs that
actually happened:

- `docs/benchmark-outcomes.json` — retains `gangContextEditPreflight` and the
  `gangcode-model-preflight-*` evidence paths, which point at temp directories that existed
  under that name. Rewriting a recorded path would make the record point at something that
  never existed.
- Untracked `artifacts/` run evidence — untouched.
- `docs/source-provenance.json` sha256 fingerprints — unchanged. They fingerprint transferred
  Stow documents, none of which were edited.

An earlier pass did rewrite those three evidence paths in `benchmark-outcomes.json`. It was
reverted. That file is a record, not prose.

## Verification

- Baseline before the rename: 269 tests, 259 pass, 10 fail.
- After: 269 tests, 259 pass, 10 fail.
- Failing test names diffed modulo timings: **identical**. The 10 failures are pre-existing in
  the mission-verifier and graph fixtures and are unrelated to this rename.
- `npm run check` passes: `Repository boundary and local links OK`.
- `grep -r gang` across tracked files returns only `docs/benchmark-outcomes.json`.

## Not done here

Stow's published documentation references GangCode by name in at least ten files, including
`docs/gangcode-stow-boundary.md`. Stow is Apache-2.0 and published, so that rename is a
separate change in a separate repository and is not performed by this commit.