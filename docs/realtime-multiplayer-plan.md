# Agents working together in one workspace

**Date:** 2026-09-29. **Status:** RT-0 observer prototype implemented; real-harness qualification in progress. Later stages remain proposed.
The user-authorized experiment is tracked in [the canonical plan](plan.md).
[Engineering detail](realtime-multiplayer-engineering.md) supports this plan; runtime,
wire format and harness protocol choices are implementation decisions.
[Review and handover](realtime-multiplayer-plan-review.md) records remaining gates.

## The problem we are solving

Several agents can each do useful work, yet collectively get in each other's way.
They act on different versions of the same code, miss changes to their dependencies,
duplicate effort or overwrite work because they do not know enough about one another.

The product should let people and agents work together in the same workspace with
shared awareness: who is working, what they are trying to do, where they last looked
or edited, and which changes matter to the work underway. An agent should adjust
before its assumptions turn into a conflicting edit.

Success is better collaboration with less human coordination. A fast message bus,
a particular language, more broadcasts or a working connection to a harness does
not establish that result.

**First user:** a developer already running two agents on a change that spans related
code, currently spending time reconciling their work. The initial experience should
join their existing workspace and preserve their chosen harness/task workflow. Measure
setup effort and ongoing supervision; a successful lab fixture alone does not show
that using the product is easier than coordinating the agents manually.

## What an agent should experience

### Arriving in a file

Before beginning work, the agent receives who is already there, what they are doing
and their last cursor/read/edit locations. Distinguish a person's caret from an
agent's last observed range. Show unknown, old or disconnected activity honestly.
The first join response carries this awareness; it is not something the agent has
to discover by polling or asking everyone separately.

Joining does not claim the file. Participants may work there simultaneously.
Knowing someone is nearby informs judgment rather than granting exclusive ownership.

### Working alongside someone

An agent declares a short current intention, such as “changing validation for empty
names,” and updates it when its task changes. This is descriptive, expires with its
execution and grants no right to block others. Its last read/edit range and confirmed
changes provide evidence alongside that intention.

The product should distinguish:

| Situation | Expected behavior |
| --- | --- |
| Another agent is editing an unrelated range | Continue without unnecessary interruption |
| Another agent is changing the same behavior or range | Assess the overlap, exchange a focused clarification if needed, then adapt or surface an unresolved conflict |
| Someone changes an interface this task depends on | Refresh affected assumptions before proposing the next edit |
| A peer explains an upcoming change | Treat the explanation as useful evidence; verify it against actual changes |
| A person's edit conflicts with an agent's stale proposal | Refuse the stale edit, preserve the person's work and let the agent reread/revise |
| An agent goes offline | Mark its awareness stale; do not make others wait for it |

Awareness cannot guarantee that independent agents will always make compatible
semantic decisions. The first observer profile warns and steers using observed changes;
it cannot refuse native filesystem writes. The later guarded-edit profile checks stale
proposals before admission and preserves accepted work. Text convergence and correct
behavior are separate acceptance checks; neither profile guarantees semantic agreement.

### Resolving overlap without blocking everyone

An overlap is a reason to assess, not an automatic stop. Agents first inspect current
work and compare intended outcomes. Compatible work continues; stale proposals are
revised. If they need to divide work, they can record a short voluntary agreement
about the next action. It never reserves a file, restricts human edits or overrides
another participant's permission to work. Reassess it when the task or relevant code
changes; a peer's silence is not agreement.

Bound clarification to two rounds, at most four participant replies per unresolved
cause in the initial experiment, with a visible task/time budget. After that, pause only the affected
mutation or task and surface a concise decision: participants' intentions, incompatible
outcomes, supporting changes and the choice needed. Other work remains active. This
is a limit on automatic conversation, not a file lock. A human steer takes precedence
within its authorized task scope. Evaluate the limit in the pilot before freezing qualification.

Completed tasks do not silently reopen because another participant sends a message.
Keep relevant changes visible; further execution requires existing authorized follow-up
scope or a new queued task. Report both adaptation and churn in the evaluation.

Evaluate TypeSafe AI's Jev as an optional rapid decision layer. Give it bounded current
intentions, confirmed changes and dependency evidence, and ask specific questions about
relevance, compatibility and whether affected context needs refreshing. Our policy turns
answers into concrete notifications or steering using the supplied evidence. Start by
recording recommendations without acting, then compare awareness alone with Jev-assisted
steering. It must demonstrate fewer clashes/interventions without excessive false alarms,
waiting or replanning. It does not replace checked edits, human direction or an agent's
reasoning about how to perform the task.

### Responding to relevant changes

Agents listen to the files they are working in and the dependencies they relied on.
A change elsewhere should reach them when it affects their task, with enough context
to understand its source, scope and uncertainty. A dependency can change while the
agent's destination file remains untouched; that still matters.

The agent receives a concise account of what changed and why it may matter, rather
than every keystroke or every transcript. It can continue, refresh its understanding,
revise its plan or ask for a decision. Record what it actually considered so a delivered
message is not mistaken for successful adaptation.

Initial dependency coverage includes declared relationships and resolvable JS/TS
imports/reexports. Unknown or stale relationships are visible. Broader language and
runtime dependencies can follow evidence from real tasks. Peer messages do not
override human direction or independently authorize new work.

### Distinguishing work in progress from usable changes

Live edits remain visible immediately. A change spanning several files can temporarily
leave the application inconsistent, so an edit arriving does not mean the new contract
is ready. Associate related edits with a change ID and expose in-progress, ready and
abandoned states, including what validation actually ran. An agent's ready declaration
is evidence, not proof of correctness or an atomic multi-file commit.

Consumers can inspect provisional work to prepare, but must verify the current required
files/revisions before relying on it. Tests/checks run against a named coherent snapshot;
show which revision passed and when results became stale. If a producer disappears,
its partial work stays visible and recoverable without holding consumers hostage.
Start with declared change groups and revision-linked checks, not general semantic
conflict prediction or automatic rollback of other participants' work.

Version each group's file/revision manifest. A later relevant edit invalidates current
readiness and check currency automatically; a delayed ready declaration for an older
manifest cannot mark the current group ready. Keep the historical result visible.

### Being guided by a person

- **Steer:** change direction during the active task, with visible evidence that the
  agent received and acted on the instruction.
- **Queue:** schedule later work without interrupting current work; allow edits,
  reordering and cancellation before admission.
- **Interrupt:** stop the current execution and block its future writes while
  preserving already accepted edits. Confirm settlement before starting a successor.

Controls target the intended execution. The UI distinguishes received, accepted,
delivered, applied and stopped; unsupported capabilities remain explicit.

## What a person should see

One shared workspace view should answer: who is active, what they are doing, which
files/ranges they last touched, what changed, and whether any participant needs help.
The editor shows presence without claims or exclusive-edit controls. The agent panel
shows intentions, current task, pending tasks and control receipts.

Expose actionable conflicts and dependency changes rather than raw transport events.
A person can join the same file, edit it and steer an agent without stopping everyone.
Saved state remains recoverable while collaboration continues.

## Product boundaries

Start with two real agents on one workspace host. No worktree coordination model and
no file claims. Qualify two explicit profiles:

- **Observer:** native harness activity and filesystem changes feed a maintained view
  of current work. Optional OTel enriches that view. Native writes continue normally;
  warnings and verified boundary steering can help, but cannot guarantee prevention of
  overwrites or late writes. Unknown authorship, ranges and read bases remain unknown.
- **Guarded editing:** agents and human editors mutate an authoritative shared document
  through checked operations. This later profile must prove stale-write refusal,
  generation/context fencing and durable accepted edits before claiming those guarantees.

First-join awareness still requires an explicit join or verified pre-read hook. A
post-completion tool span cannot retroactively satisfy the first-message requirement.
Human shared-editor and remote participation follow evidence from the first profile.

Support OpenCode first using the existing proven caller, then qualify native Codex
and Pi participation. Provide portable tool access for ChatGPT and other harnesses.
Each integration is described by what the agent can actually do: join with awareness,
observe changes during work, make checked edits, accept steering and settle interruption.
Tool access alone is not a claim that every host supports active realtime control.

Continuously ingest native events and observed file changes using ordinary code, then
maintain revisioned state rather than repeatedly feeding raw logs to a model. Distinguish
assigned goals, authenticated declared intentions and inferred recent activity. Native
event IDs and verified callbacks establish control state; telemetry adds labelled evidence.
Late/duplicate observations cannot revive an old execution or certify a read revision.
Missing events trigger bounded reconciliation and visible uncertainty.

Build a compact evidence cut only when a relevant assumption changes. Start with shadow
recommendations, then advisory notifications, then qualified steering within the active
task. The initial catalog is no action, notify, refresh context, steer current task or
ask a person. Automatic interruption and new-task admission are disabled initially.
One outstanding classification per task, deduplication, coalescing and total cost/time
budgets prevent an inference call for every span. Human steering supersedes pending
automatic decisions even if no code or execution generation changed.

OTel is optional enrichment, not the latency-critical source. Measure export freshness
and actual fields before using them in a decision; a full collector stack does not gate
the first probe. Record delivery, consideration and independently observed adaptation
separately. A listener callback or an unrelated successful edit does not prove adaptation.

Stow continues to save and restore workspace state. Collaboration belongs to the
caller/product above it under [ADR 0014](reference/stow-storage-boundary.md).
This repository owns the product, dependencies, tests and eventual releases.
Stow is an optional integration through its public API/CLI; the observation loop
runs without Stow. The [repository boundary](realtime-repository-boundary.md) records
the extraction. Stow retains dated source evidence and a project pointer.
The existing ownership-based [prototype](reference/stow-source-record.md)
is useful evidence, but it does not yet demonstrate this experience.

## Delivery plan

Each step must demonstrate an observable improvement in agents working together.
The RT identifiers also link to the supporting engineering work; they are not a
second backlog.

Begin RT-0 with continuous observation of two real OpenCode agents in an executable
dependency-change fixture. Maintain current task/file state, replay adverse event
schedules and score shadow decisions. Use declared dependencies and independent checks;
do not require a shared editor, CRDT, codec competition or other harnesses to test this
first value proposition. RT-1 tests useful delivery/steering at a verified execution
boundary. Supply observations rather than an exact repair prompt; keep write safeguards
equal in every comparison. Later-turn-only delivery is labelled honestly.

| Step | Demonstration | Acceptance |
| --- | --- | --- |
| RT-0: prove observation and decision evidence | Two real agents work in one native workspace; events and changes maintain current state; decisions run in shadow | Coverage, freshness, attribution and control capabilities have receipts; delayed/missing/duplicate observations remain honest; an explicit continue/narrow/stop decision precedes expansion |
| RT-1: prove useful awareness and bounded steering | Participants join with awareness; relevant changes reach active work; compare deterministic awareness with optional Jev | First response contains existing presence and last known locations; no claims; observed adaptation reduces reconciliation at acceptable overhead; newer human direction defeats stale decisions |
| RT-2: protect concurrent work | A person edits while an agent prepares an overlapping change | Compatible edits survive; stale conflicting proposals fail before overwriting work; confirmed edits survive disconnect/crash |
| RT-3: broaden dependency and harness coverage | Two real agents and two people work in one file, then repeat with two qualified harnesses | Parser lag is reconciled, inherited context is accounted for and current change-group readiness is truthful; mixed-harness adaptation has independent evidence; unrelated activity causes no model turn |
| RT-4: give people effective control | Steer one agent, queue work and interrupt another while editing continues | Active direction changes before natural task completion; queueing does not preempt; stopped executions cannot write later; other participants remain responsive |
| RT-5: recover shared work | Save while edits continue, then restore the chosen revision | Exact saved bytes and confirmed collaboration receipts recover; historical presence/processes do not restart; uncertain work is reconciled |
| RT-6: qualify real remote collaboration | Two devices and multiple harnesses repeat the scenarios | Supported limits, access boundaries, latency and recovery behavior have reproducible evidence |

RT-0 selects implementation choices only as needed to make observation work.
The storage core remains Go. The collaboration runtime and serialization are open
choices, including Protobuf, evaluated against responsiveness, reliability and
maintenance when the corresponding room workload exists. Use the existing caller
runtime for the first probe; runtime/codec competitions do not gate proof of value.
No language migration is a product milestone.

## How we will know it helps

The [evaluation protocol](realtime-collaboration-evaluation.md) defines controlled
comparisons, event barriers, independent scoring and evidence limits. It has not run.

Use real collaborative tasks with deliberate overlap, not just demonstrations where
each agent writes a separate file. Run the same tasks with shared awareness disabled
as a baseline. Record outcomes and explain ambiguous results rather than claiming
that notification delivery proves coordination.

Measure:

- Conflicting/stale edits detected, silent overwrites and recovery effort.
- Duplicate work, incompatible changes and human interventions needed to reconcile them.
- Whether an agent refreshed relevant assumptions before its next edit, including
  when only an upstream dependency changed.
- Whether peer intentions helped agents continue independently or resolve overlap.
- Task correctness and completion effort, alongside extra model turns/context cost.
- Time to first awareness, peer-change visibility and control receipt; responsiveness
  while models run, storage is slow and clients reconnect.

Initial local room targets are p95 50 ms for warm presence, accepted peer-edit delivery
and control receipts. These are proposed qualification targets, not observed results
or model-response guarantees. Model calls do not sit in the presence/edit delivery path.

Required adverse cases include stale cursor positions, simultaneous joins, overlapping
and reverted edits, upstream contract changes, missing dependency coverage, repeated
messages, queued successors after abort, interruption during edit admission, slow
consumers, failed persistence and an old client reconnecting after restore.

Also test conflicting intentions, unanswered clarifications, stale voluntary agreements,
repeated reciprocal messages, abandoned multi-file changes and checks passing an old
revision. Record whether an agent sensibly continues unrelated work or waits unnecessarily.

Before expanding beyond the pilot, freeze the minimum useful improvement, acceptable
usage/setup overhead and failure limits from the observed baseline. Retain all trials,
including failures. Rework or stop expansion if awareness does not reduce reconciliation,
creates sustained notification churn, or adds more supervision than it removes. Any
silent loss of an accepted edit is a correctness failure, regardless of coordination gains.

Use separate advancement decisions for trustworthy observation, deterministic awareness,
incremental Jev benefit and voluntary user reuse. Useful routing can ship without Jev
if classification adds cost or churn. Retain every assigned qualification run, including
timeouts and missed observation opportunities; steering itself may change whether a
scheduled read happens. Report opportunity-qualified adaptation separately.

## Next action

Finish RT-0 native qualification and record the available event/control fields and
independent diagnostic outcomes. The observer, state reducer, first-join snapshots and
bounded deterministic shadow lane are implemented in this repository. Jev has not been
evaluated. RT-1 useful collaboration, guarded editing and remote participation remain
unqualified. The diagnostic probe is not evidence of general reliability or adoption.
