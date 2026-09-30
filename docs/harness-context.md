# Harness context contract

The initial connection returns one task-scoped workspace context envelope alongside
file presence. It includes the assigned task and execution identity, accepted and
delivered direction revisions, existing participants and intentions, last known
positions, relevant file revisions, declared dependencies, read bases and coverage.
The adapter puts this envelope in the first native task message before work begins.
It is not a separate unrelated notification stream.

Connection presence is captured when the model task connects. Later causal envelopes
retain that connection basis while refreshing current room participants and locations.
They explain the observed cause and the affected dependency/read basis without supplying
a repair answer or changing the task. Peer text is descriptive evidence; human direction
and the assigned task retain authority. Context is bounded at 32 KiB and omissions are
explicit. Native read offsets are requested read ranges with uncertain units, not editor
carets. Unobserved positions, authorship and revision verification remain unknown.

The OpenCode adapter subscribes to the volatile native live feed before task admission.
Disconnects create coverage gaps; this transport cannot replay. Retained-log readiness
alone is insufficient when native persistence is disabled. Content observation and native
activity are separate sources, and neither fences a subsequent native filesystem write.

Evidence separates native admission, inbox delivery and projected context incorporation.
The probe matches the exact admitted user-message ID and text in the native context in
memory and stores only proof metadata. It also checks initial delivery ordering against
the first observed tool event. Neither check alone establishes which provider request
consumed that message or that the agent changed its reasoning. Independent outcome
checks and further controlled comparisons remain necessary.

This increment supports OpenCode only. Codex/ChatGPT, Pi and other harness adapters
must establish their own initial injection and model-boundary delivery capabilities;
telemetry alone cannot satisfy the context contract.

The next native seam is primary-turn context injection through an OpenCode plugin.
See [integration model](opencode-integration.md) for the installed compatibility proof
and the separate receipts required for request-local context, durable inbox delivery
and agent adaptation. The existing production adapter has not yet migrated.
