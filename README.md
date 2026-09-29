# Agent Collaboration

A standalone experiment in agents working in one native workspace with shared awareness.
No file claims. Native observations describe activity and changed bytes; they do not
prevent overwrites. Stow checkpointing is an optional later integration.

```sh
npm test
npm run check
npm run demo
npm run probe:real
```

Add `-- --serve` to the probe command to keep the read-only live view open.

The harness supplies task-scoped workspace context with the initial connection,
including existing participants and their last known cursor. Later dependency changes
use the same contextual envelope. See [the harness contract](docs/harness-context.md). Unknown locations and observation gaps stay visible.

The real probe uses a dedicated OpenCode 2.0.16 server and your selected OpenCode model.
It reads the existing provider login only in opt-in real mode, keeps it in memory and
scopes child HOME/XDG state outside the fixture. It creates a temporary fixture and
sanitized evidence; it does not modify user workspaces or global harness settings.

The deterministic demo checks the apparatus. A small real probe is diagnostic, not
proof of reliable collaboration or Jev benefit. See [plan](docs/plan.md).

Node 22+; no runtime packages or Stow checkout required for the initial probe.
Private working repository, Apache-2.0. Source provenance is in
[the transfer record](docs/source-provenance.json).
