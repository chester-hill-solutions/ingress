# Dependency-aware checkout experiment

User-directed experiment, 2026-10-12. Question: can a checkout arbiter let agents edit
disjoint blocks concurrently while excluding overlapping modifications and known
impacting/impacted dependencies? Can EmbeddingGemma 2 find relationships absent from
the declared graph without blocking too much independent work?

This is an in-memory terminal prototype, separate from the deployed product and its
[ordered hardening queue](product-hardening-plan.md). The observation harness still
has no file claims and cannot prevent stale writes. No RT status changes. The new
experiment uses exclusive, revision-relative modification grants; that is a deliberate
user-directed exploration beyond the observer's non-exclusive design.

## Run

Core commands require only Node built-ins, neither Stow nor OpenCode:

```sh
npm run checkout:prototype
npm run checkout:prototype -- --demo
npm run checkout:evaluate -- --output artifacts/checkout-baseline-v1.json
```

In the terminal, try:

```text
checkout a discount
checkout b shipping
checkout c invoice
edit a pricing.mjs 2 "  return subtotal * (1 - rate / 100);"
submit a
edit b pricing.mjs 6 "  return weight > 15 ? 20 : 5;"
submit b
```

A and B hold different blocks of the same file. C is refused because invoice depends
on the discount calculation. A's change publishes first; B's change merges from B's
original base and both changes survive. Edit a line outside a grant to see a submission
refused. `tick 60001` expires the initial leases; `reset` starts a fresh tree.
`checkout a discount 2 2` requests just line 2 of that block.

## Contract and enforcement

The contract below describes the original admission core. The subsequent
[candidate-bound expansion increment](#candidate-bound-expansion) extends whole-block
grants in the local experiment; previous campaign results remain fixed.

- Blocks have operator-supplied identities, inclusive line ranges and exact file hashes.
  Grants are based on arbiter-owned copies, never a caller-supplied revision number.
- Confirmed edges mean `from` depends on `to` and require recorded evidence. Forward
  and reverse transitive closures protect impacting and impacted blocks. Shared readers
  coexist. Closures are walked separately, avoiding an undirected traversal through
  every sibling of a shared utility.
- Every requested scope is granted together or refused together. Expiry, renewal and
  release are explicit. There is no waiting queue or fairness guarantee yet.
- Submission checks actual full-file diffs against the original modification ranges,
  including insertions and deletions. An insertion belongs to the following line; an
  append at EOF belongs to the last line. New files, file removal, binary content and
  files longer than 1,500 lines are outside this prototype.
- Protected dependency changes refuse a submission. Compatible same-file edits use
  the existing production text merge. Publication requires a synchronous validation
  callback and changes the tree only after the whole candidate passes. The terminal
  callback checks syntax only; it does not establish semantic correctness.
- After a changed file publishes, its catalog entries are stale. The operator must
  re-index before granting new scopes involving them. Active grants keep their exact
  original copies. Different coordinate bases conservatively conflict on the same path;
  this prototype does not relocate symbols automatically.
- Files and leases live in memory. Checkout IDs and participant IDs are API parameters,
  not authenticated identities. Native filesystem access, protected reporter execution,
  durable storage and production authentication are not implemented here.

The graph's coverage is operator-declared and its completeness is unknown. Even perfect
exclusion of its known scopes cannot prove the absence of unrecorded behavioral coupling.
Private copies prevent shared in-memory mutations; this is not a host filesystem sandbox.

## Candidate-bound expansion

`GraphCheckout.expand({ checkoutId, participantId, files, additionalWrites }, now)`
builds a fresh trusted graph for the proposed tree. Newly introduced helpers or import
bindings need explicit modification requests; newly referenced existing providers need
dependency protection, not modification permission. Existing blocks can be added only
by an explicit request. Unknown relationships remain refusals.

The core checks deleted lines against authorized base blocks and inserted lines against
authorized proposed blocks. Blank gaps directly adjoining new helpers are permitted;
blank lines inside unrelated template literals remain data edits and are refused. Unrelated
existing code is not. It checks proposed modifications and dependency protections
against every other active grant using the existing conflict rules. Changed coordinate
bases on a shared file conservatively conflict. It atomically replaces the original
grant only after all checks pass; a refusal leaves that live grant intact. Expiry and
wrong-owner checks precede graph work. Expansion does not publish any bytes or renew
the lease.

The expanded grant authorizes one exact candidate. A later change to that candidate
needs another expansion request. Publication still requires synchronous validation.
Any head change since checkout refuses expansion and requires fresh issued bytes and
another edit attempt. No stale candidate is automatically rebased or relabeled. Both
original and proposed modification/dependency protections remain active until release,
expiry or publication. V1 expansion supports whole blocks in existing files only;
subrange grants, new files and deletions of files remain unsupported.

The native bridge and replay runner explicitly request introduced blocks after a scope
refusal in both scoped arms. Every initial refusal, expansion attempt and resubmission
is recorded. A conflicting native expansion exits the publication wait loop and uses
the bounded release/reacquire/edit path, avoiding an unbounded wait while holding the
original grant. There is still no fairness or general deadlock-freedom guarantee.

The bounded producer additionally resolves `Math.min`, `Number.isInteger`, contained
named helpers and single-parameter arrow bindings. Shadows and reassignment remain
refusals, and every contained helper body is walked for external dependencies. Arbitrary
receiver methods and dynamic callbacks still lack proof. Runtime intrinsics are assumed
unmodified as in the original producer; this is not general JavaScript resolution.

Sixteen model-free expansion regressions use frozen real AST facts or independent
operator catalogs. They cover helper
insertion, dependency protection, atomic conflict refusal, independent paths, unrelated
edits, freshness, expiry/ownership, exact-candidate authority, validation, new paths,
subrange refusal and runner integration in both scoped arms. No deployed routes or
authenticated durable storage are added by this increment.
See [qualification and comparative follow-up](checkout-expansion-results.md).

## Retained EmbeddingGemma 2 experiment (outside v1)

The inference adapter and these commands remain available to reproduce the recorded
experiment. Embeddings are excluded from the planned v1 checkout path; there is no
scheduled follow-up embedding trial. The observed exclusion cost does not establish
that embeddings are generally useless, but it does not justify their runtime complexity
for this arbiter.

The optional service follows Google's [developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/)
and [model card](https://huggingface.co/google/embeddinggemma-2). It loads the 270M
text/code configuration on CPU with float32 precision and 768-dimensional embeddings.
Blocks use titled document inputs; requests use the `CodeRetrieval` prompt. Token-limit
overflow is refused rather than silently truncated. The unified processor needs image
and audio/video support packages even though those encoders are disabled.
The default checkpoint is pinned to `914f7f89142e33e77833254d9c9b90c3cef7303b`,
the snapshot cached during this experiment. `--revision` selects another explicit run.

In a separate terminal:

```sh
python3 -m venv artifacts/checkout-inference-venv
artifacts/checkout-inference-venv/bin/python -m pip install 'sentence-transformers[image,audio,video]>=6.1.0' transformers
artifacts/checkout-inference-venv/bin/python scripts/checkout/embeddinggemma-server.py
```

Then:

```sh
npm run checkout:evaluate -- --embeddings --output artifacts/checkout-embeddinggemma-v1.json
npm run checkout:prototype -- --embeddings
```

The service listens only on loopback. The Node adapter refuses remote origins and
redirects. Model weights are downloaded on the first run and cached under ignored
`artifacts/`. No provider login is used and no vectors or generated prose are committed.

Matches remain candidates with unknown dependency direction. Similarity scores are
not confidence probabilities. Default `policy suggest` leaves candidates advisory.
`policy protect` adds them to protected scopes explicitly. The evaluation measures that
conservative policy to expose both missed interference and unnecessary exclusion.
`--top-k` and `--minimum-score` control retrieval; tuning them is a new retained run.
An unavailable service produces an unavailable arm with all assigned cases preserved.

## Evaluation and next decision

The frozen fixture has 11 hand-authored cases, including both directions of a
persisted invoice/refund contract omitted from the declared graph and independent
lookalike code. Ground truth is not passed to the arbiter. Boundary counterexamples
also exercise identity matching, expiry, range enforcement, atomic refusal, copy
isolation, validation and line-coordinate changes.

Observed 2026-10-12, top-K 3 and minimum cosine similarity 0.2:

| Arm | Assigned/completed | Missed interference | Unnecessary blocking |
| --- | --- | --- | --- |
| Declared graph | 11/11 | 2 | 0 |
| Graph + protected embedding candidates | 11/11 | 0 | 4 |

The embedding policy refused **all four independent cases**, including disjoint blocks
of one file, shared readers, similar independent examples and unrelated files. It also
prevented the two omitted-contract conflicts. That does not establish useful benefit:
refusing everything would also miss no conflicts. Default suggestions therefore remain
advisory until a relationship is evidenced. A ranking threshold is not a dependency proof.
This is a small synthetic fixture, not a repository-wide dependency audit or RT-1 result.

All assigned rows and candidate scores are retained locally in
`artifacts/checkout-embeddinggemma-v1.json`; the independent baseline is in
`artifacts/checkout-baseline-v1.json`. The service initially reported no model revision;
the downloaded config's cache snapshot was independently checked as
`914f7f89142e33e77833254d9c9b90c3cef7303b`. The server now pins that snapshot explicitly.
No vectors or source-code payloads are saved in these reports.
The final boundary-check run is `artifacts/checkout-baseline-v2.json`; the earlier run
is retained. A pinned-service smoke run produced a finite 768-dimensional vector and
refused remote endpoints, browser-origin requests, empty batches and token overflow;
its metadata/check results are in `artifacts/checkout-embeddinggemma-service-smoke.json`.

Execution attempts retained as outcomes: the initial sandbox dependency download could
not resolve its package host; the permitted temporary install succeeded. The first
model startup refused because Pillow was absent; the second refused because torchvision
was absent. Installing the guide's processor extras allowed the third startup and all
11 comparison cases to complete. No model failures or comparison rows were discarded.
The fourth startup verified the explicit checkpoint pin. Both successful servers were
stopped after their checks; weights remain cached for reuse.

Verification: 18 independent boundary counterexamples pass; an interactive terminal
smoke check granted disjoint blocks, refused a dependency conflict and published both
same-file edits at revisions 2 and 3. The full existing suite
passes 784/784 under Node 26.11.1 with a 60-second per-file ceiling, and the repository
boundary/link check passes. The initial sandboxed suite stalled on an existing renewer
child and was stopped; its output is retained in `artifacts/checkout-node26-tests.tap`.
The completed run with child-process permissions is retained in
`artifacts/checkout-node26-tests-permitted.tap`. No live agent harness trials were run.

Promotion requires actual repository indexing and evidence extraction, a trusted
durable arbiter/publication transaction, private filesystem permissions and independent
behavioral validation. These must enter the product hardening queue explicitly before
any deployed routes adopt this contract. Until then the terminal shell stays an experiment.

## Implementation sequence

Planning amendment, 2026-10-12, following the user's Graphify proposal. Product work is
now recorded as item 14 in the [ordered hardening queue](product-hardening-plan.md).
Slice 1 has now been probed with a failed target-binding check; its raw graph remains
unqualified as a grant authority. Slice 2 now has a bounded lab adapter and admission
qualification, recorded below; its production scope and slices 3-6 remain open. The existing prototype
demonstrates scope arithmetic; none of these production capabilities is established
by that demonstration.

The user selected submission/publication enforcement for v1, with private checkout
copies. Agents can edit their own copies freely; only changes within live granted
scopes may publish. Preventing local edits outside a grant is a separate stronger
profile deferred beyond v1. A directory per agent alone does not enforce private
filesystem access against another process with the same host permissions.

V1 uses code-only structural extraction and explicit evidenced contract records.
Embeddings, vector indexes and inference services are outside its grant/publication
path. Cross-data-boundary contracts can be recorded explicitly with source/version
evidence. Unknown relationships remain unknown and trigger the configured conservative
scope or refusal; a structural graph is not a complete behavioral-impact oracle.

### 1. Qualify extraction on real repository code

**Now:** Graphify 0.9.62 has been run offline against a pinned product-source copy.
The qualification below passed 37 of 38 checks and found a falsely resolved call under
parameter shadowing. The original terminal prototype uses its manually declared fixture graph; a separate
lab qualifier now consumes guarded AST facts and explicit contracts.

**Change:** use an isolated, pinned Graphify CLI/library as an optional offline producer.
Start with an immutable copy of `src/product/`, record the explicit scan root and exact
file manifest, and use code-only extraction. Do not install assistant hooks or rewrite
agent instructions to obtain a graph. Save raw tool output only under ignored artifacts;
retain a bounded manifest with producer/schema versions, file hashes, scanned/skipped
paths, parse failures, unresolved calls, runtime and graph counts. The Node decision
core and deterministic tests must still run with no Graphify installation.

**Verified by:** independently trace known imports and calls in the product's
lease/content/commit path. Check renamed imports, re-exports, class methods, duplicate
names, dynamic dispatch, multiline definitions and function end positions against the
actual source. A plausible populated graph must not conceal a parser failure.

**Done when:** the observed output contract, supported MJS syntax, physical symbol
spans and unresolved-reference behavior are recorded. If required spans or resolution
are absent, qualify an AST adapter for those facts before proceeding; do not synthesize
missing ranges from a model or assume the graph is complete.

### 2. Normalize the graph and define grant policy

**Now:** `createCatalog` accepts simple ranges and undifferentiated declared edges.
The bounded lab adapter now verifies source/span/version evidence, discards unverified
Graphify calls and refuses unresolved outgoing calls; production integration is open.

**Change:** add a producer adapter into that catalog path, with versioned records for
symbols, source hashes, spans, directed relations, extraction/resolution provenance,
evidence locations and eligibility for protection. Define a relation allow-list and
bounded forward/reverse traversals. Calls/imports require appropriate resolution;
containment, documentation mentions, similarity and graph-community membership do not
automatically become dependency locks. A traversal exceeding its cap refuses explicitly;
it must not silently truncate the scope.

Graphify's [architecture contract](https://github.com/Graphify-Labs/graphify/blob/v8/ARCHITECTURE.md)
records a critical integration detail: its exported graph says `directed: false`, but
each link's arc order is directed; legacy `_src`/`_tgt` markers take precedence. Preserve
that direction explicitly. The same contract distinguishes `EXTRACTED`, `INFERRED` and
`AMBIGUOUS`; an inferred static symbol resolution and a semantic guess need different
eligibility rules even when the producer labels both inferred.

Unresolved potentially relevant relationships must stay unknown. Use a recorded
conservative file/module scope or refuse the targeted grant when sufficient coverage
cannot be established. A graph confidence tag or embedding score alone cannot authorize
an absence-of-interference claim. Explicit contract relationships are versioned with
their evidence and policy, and invalidate when those sources change. V1 does not
automatically discover or promote relationships through embeddings.

**Verified by:** captured extraction fixtures test direction, duplicate identities,
schema incompatibility, source mismatch, missing spans, dangling edges and ambiguity.
Compatibility fixtures cover direct overlap, impacting and impacted dependencies,
shared readers and independent callers of a common utility. Ground truth stays outside
the graph producer and arbiter.

**Done when:** a real source request maps to exact pinned scopes and every protection
or uncertainty has an inspectable reason. The baseline makes these decisions without
model inference. The prior embedding experiment remains retained outside v1; additional
embedding work would require a concrete unresolved use case and a separate evaluation.

### 3. Issue durable, authenticated checkouts

**Now:** the prototype stores a complete tree per grant in memory; IDs, time and expiry
are local parameters. Product content has per-file revisions but no qualified atomic
workspace-wide checkout manifest or retention pin for an active block grant.

**Change:** extend the existing lease/content seams rather than add a second production
authority. A checkout references an immutable workspace manifest, exact graph snapshot
and policy version. Persist participant-bound identity, scopes, lease generation,
expiry/revocation and the base-retention pin. Read-through serves only the pinned base;
local writes remain private. Hold the canonical writer credential only in the arbiter.
Bound active grants and retained bytes; refuse capacity overflow before issuing a grant.

Grant all requested scopes together or none. Add atomic scope expansion, renewal,
release and bounded waiting with deterministic expiry/revocation. Expansion must not
leave two participants holding partial scopes while waiting on each other; if an atomic
expansion is unavailable, return a retry plan that preserves work and releases/reacquires
the needed scopes. Scheduling checkout access is separate from admitting the whole agent
roster concurrently. Waiting for a scope must not silently turn a simultaneous trial into
a serial or batched agent launch.

**Verified by:** restart preserves live grants and bases; expiry/revocation fences old
generations; read-through misses never fetch a newer revision; capacity and partial-grant
failures leave no grant; abandoned and competing expansion requests do not deadlock.

**Done when:** a restarted authority can serve the same base and make the same grant
decision from durable facts, and only a live authenticated holder can submit under it.
The guarantee still concerns canonical publication unless a native filesystem boundary
is separately implemented and verified.

### 4. Integrate submissions with graph publication

**Now:** the prototype diffs against its issued base and reuses the production text
merge, but accepts only synchronous validation and requires manual re-indexing. The
product's actual commit path lives in `handlers/commit.mjs`.

**Change:** carry the issued checkout identity through the existing manifest and commit
path. Compute modification scope and provenance from arbiter-owned bases and incoming
bytes. Support explicit create/delete/rename operations and whole-file/binary scopes
with defined conflict rules; ambiguous symbol relocation remains a refusal or fallback.

Stage a candidate merged tree against a captured head, extract its graph and compare
new/removed/changed dependencies. A newly introduced relationship that reaches an active
protected scope requires an expanded grant and another decision. Incomplete extraction
cannot be treated as a graph with no dependencies. Run independent build/behavior
validation asynchronously outside the short publication critical section.

Before publication, recheck the head, graph/policy versions, grant generation and expiry,
and any added dependency scope. A changed cut forces recomputation and revalidation.
Stage immutable code/graph objects first, then atomically advance one head reference
that names both. An object-store upload sequence alone is not an atomic workspace commit.
Pin the exact candidate validated so a later local edit cannot be substituted. Use an
idempotency key and durable receipt so an interrupted response can be reconciled without
publishing the submission twice.

**Verified by:** two disjoint same-file edits survive; out-of-scope or dependency changes
cannot land; validation rejects a textually clean but broken result; a concurrent commit
or expired grant during validation forces retry/refusal; crash/replay probes never expose
code with a mismatched graph or advance the head twice. Refused work stays retrievable.

**Done when:** successful receipts name the exact code, graph and validation evidence
published together, and uncertain delivery can be reconciled by submission identity.

### 5. Connect actual private working copies

**Now:** terminal checkouts are JavaScript objects. The deployed design has an external
model loop and a deterministic container sandbox; the in-container reporter is writable
by its participant and is not an independent provenance witness.

**Change:** extend the existing workspace client/runner to materialize a pinned copy,
obtain and expand scopes, submit the actual candidate bytes, handle refusals and recover
unfinished work. Give agents a read-only canonical view and a private write destination;
the arbiter alone publishes. Validate producer output as incoming data even if the local
reporter is replaced. Never base correctness on its unverified assertion that it listed
every local change or observed every read.

The selected v1 profile allows arbitrary edits inside the private copy and admits
only changes within live grants. The stronger local-edit profile needs an enforced
editor/tool path or filesystem/OS boundary, including shell writes, patch commands,
symlinks and access to peer copies. A tool hook alone cannot cover unrestricted shell
access. Select that boundary before promising native edit prevention.

**Verified by:** an actual two-copy workflow, concurrent editing, interrupted work,
scope expansion and resubmission through the receiving authority. A deliberately changed
reporter cannot bypass the canonical gate. Test cross-copy/canonical write denial only
for a profile whose host permissions actually enforce it.

**Done when:** the end-to-end workflow runs with a documented enforcement profile,
credentials stay host-local and failed submissions remain recoverable. Stow contract
tests, if added, use a pinned public artifact and remain optional.

### 6. Run the independent comparison before promotion

**Now:** the synthetic 11-case trial measures admission behavior; it does not qualify
repository-wide impact analysis, host isolation or useful collaboration benefit.

**Change:** freeze representative repository tasks and independent acceptance criteria.
Compare private copies plus merge alone, whole-file grants, and graph-backed block
checkouts with evidenced contract records. This measures whether graph/block scopes
buy concurrency without depending on semantic retrieval. Use deterministic fixtures for correctness/crash invariants;
real harness trials remain opt-in and use the configured model. Predeclare the assignments,
budgets, thresholds and retry rules and preserve every assigned outcome.

**Verified by:** correctness, missed interference, unnecessary exclusion, grant waiting,
concurrent progress, re-index/validation time, recovery and operating cost. Include new
dependencies, dynamic references, shared configuration, contracts across data boundaries,
deletes/renames and a heavily referenced utility. An arm that refuses everything cannot
be called successful merely because it misses no interference.

**Done when:** the mechanism meets its invariant gates and the report supports a precisely
bounded adoption decision. Claims about useful benefit and RT-1 remain separate gates;
one demonstration cannot close them.

### First deliverable

Start with slice 1: a reproducible code-only graph of an immutable product-source copy,
an independently checked extraction/coverage report, and the exact adapter requirements
revealed by that output. No production route or model run is needed to produce it.
This establishes whether Graphify supplies the facts the checkout contract requires
before durable integration depends on it.

### Measured Graphify qualification

The user requested testing on 2026-10-12. Graphify 0.9.62 was installed in an isolated
temporary environment with no assistant hooks. Both the preliminary product extraction
and the subsequent product/edge-case/malformed-source campaign are retained under
`artifacts/graphify-qualification-v1` and `artifacts/graphify-qualification-v2`.
The second run's authoritative check ledger is `qualification.json` in that directory.
The final reproduction with clarified call-site diagnostic wording is retained in
`artifacts/graphify-qualification-v3/qualification.json`; it independently reproduced
37/38 and the same failed binding check. Earlier runs remain retained.

| Observation | Measured result |
| --- | --- |
| Product source | 24/24 MJS files, 298,480 bytes, source hashes unchanged |
| Raw graph | 245 nodes, 619 edges; seven independently selected product call traces passed |
| Producer runtime | 568 ms for the product extraction in the second run; not a scale benchmark |
| Model use | Code-only; reported input/output model tokens both zero |
| Native callable ranges | 170 callable nodes, zero end ranges in raw output |
| AST span sidecar | 170/170 callable nodes mapped; all ten hand-authored product/feature range oracles passed |
| Qualifier checks | 37/38 passed; parameter-shadowing call resolution failed |

Aliases, re-exports, distinct same-named functions, class methods, multiline definitions,
UTF-8 byte positions and both directions of reciprocal calls passed the selected checks.
Computed dispatch stayed unresolved. These observations qualify the measured subset,
not complete application-impact coverage.

The failed case imports `increment as renamed`, then defines
`function shadow(renamed) { return renamed(3); }`. Graphify emits an `EXTRACTED` call
from `shadow` to the imported `increment`, although the parameter is the invoked value.
That edge must not be eligible for locking based on its producer confidence tag.
The probe exits nonzero for this failed qualification and does not rewrite the oracle
to make it pass. Its sources and all check rows are retained for reproduction.

The deliberately malformed MJS file also produced a graph (two nodes, one edge) and
exit status zero. A separate Tree-sitter inspection detected its parse error. Successful
CLI exit, source-file count and a populated graph therefore cannot be the readiness gate.
Malformed input must remain ineligible for targeted grants.

The code-only `--no-cluster` result is a raw `{nodes, edges}` extraction with directed
source/target arcs, not the documented packed `directed: false` view. It lacks producer
schema/version metadata; the probe envelope pins the version. One product edge points
to an absent `cloudflare:workers` external node; the fixture's re-export alias also leaves
a dangling import edge even though the ultimate call resolved. These require an explicit
external/dangling-edge policy. The sidecar records parse diagnostics and source hashes
alongside exact ranges; it is a measurement helper, not a trusted dependency resolver.

The sidecar observed 1,160 outer-syntax product call sites. Its simple name/location
matching left 918 without a matching named graph edge; that group includes builtins,
external calls, aliases and dynamic references and is not a count of missed application
dependencies. The executable reporter embedded in `launcher.mjs` is a source string and
is not parsed as executable code by this pass. Coverage for it stays explicitly absent.

At that checkpoint, the next work was to preserve raw graph evidence, validate lexical
bindings before making call
edges eligible, reject parse errors, and add conservative handling for unresolved and
external dependencies in slice 2. No graph-backed product grants have been enabled.
The full Node 26 suite passed 784/784 again, the arbiter's 18 boundary checks passed,
and repository boundary/link checks passed. No embeddings or real agent trials ran.

Reproduce the optional qualifier (use a fresh output directory for each run):

```sh
python3 -m venv artifacts/checkout-graphify-venv
artifacts/checkout-graphify-venv/bin/python -m pip install graphifyy==0.9.62
npm run checkout:graphify -- --python=artifacts/checkout-graphify-venv/bin/python
```

The decision core and ordinary tests still need neither Graphify nor its Python packages.

### Standalone qualification repository

The user requested a repository for testing. The reusable source template is
[checkout-lab](../fixtures/checkout-lab/README.md). It is also materialized as the local
Git repository `/Users/ladmin/WebProjects/checkout-arbiter-lab`, outside the Ingress
checkout. It has no remote or commits; source hashes provide its initial content revision.
Create a new copy with `npm run checkout:lab -- --destination=/absolute/new/path`.
An existing destination is refused without modification.

The app executes order pricing, serialization, payment, inventory reservation,
notification and refund workflows across 16 MJS modules. Its 19 baseline checks use
independent numerical/behavioral expectations; two explicit contract records describe
data dependencies beyond direct imports. Thirteen prospective checkout cases live in
an oracle-only JSON file that must not become graph or arbiter input.

Verification on the actual standalone copy: 19/19 baseline checks passed, including a
baseline rerun after candidate replays. All three replay assignments are retained: a
valid new dependency passes behavior but requires a future scope-expansion decision;
malformed source fails syntax/behavior; a valid cents-to-dollars edit fails behavior.
These replays do not invoke an arbiter and do not certify its prospective decisions.
The parent repository's full suite passed 803/803 with these 19 lab checks included;
its output is retained in `artifacts/checkout-lab-node26-tests.tap`.
The first draft's mutation-anchor check found two matching returns; the anchor was made
function-specific before materialization. Early replay check filenames were moved out
of default test discovery, preserving logs and file mappings in the template's ignored
`artifacts/retained-test-paths.json`; later replays use explicit check filenames.

The separate code-only Graphify extraction, with oracle data excluded, scanned 16/16
modules and produced 43 nodes and 109 edges, with zero reported model tokens. The AST
sidecar mapped 24/24 callable spans and found no parse errors. It reproduced the false
`sendCustomReceipt` to imported `notify` call under parameter shadowing. Its pinned
source manifest, raw graph, inspection and summary are retained in
`artifacts/checkout-lab-graphify-v1`. This supplies a functional regression corpus for
slice 2; no graph-backed grants or real-model assignments ran at that checkpoint.


### Graph-backed lab admission qualification

On 2026-10-12 the actual standalone repository was connected to the in-memory arbiter
through [graph-index.mjs](../src/prototypes/checkout/graph-index.mjs) and
[graph-checkout.mjs](../src/prototypes/checkout/graph-checkout.mjs). The fresh Node 26 run
is retained at `artifacts/checkout-qualification-v3/results.json`; preliminary runs v1
and v2 remain retained. This qualifies bounded local submission mechanics, not a deployed
or durable checkout service.

The optional producer uses Tree-sitter 0.25.2 / JavaScript grammar 0.25.0 for physical
spans and lexical bindings, plus Node's module syntax check. It supports named top-level
MJS functions/constants and named relative imports/re-exports. Local parameter, block,
catch and arrow shadows conservatively override imports. The index binds every file
hash, symbol span, relation evidence and explicit contract to its source revision.
Unsupported module syntax refuses indexing; unresolved calls refuse affected checkouts
and static callers. Excess scope refuses instead of silently truncating dependencies.

Graphify 0.9.62 still runs code-only against an immutable source copy, with zero model
tokens. Its confidence labels are never authority: only independently matched lexical
call targets may be recorded as eligible. All other raw relations remain retained as
ineligible; validated references and binding ranges come from the AST producer instead.
The false `sendCustomReceipt -> notify` edge is discarded. Ordinary Node tests use
[frozen source-hashed facts](../fixtures/checkout-graph/README.md), so they require no
Python installation. Producer/adapter hashes identify the exact implementation tested.

The independent checkout oracle was consumed only by the evaluator after the baseline
index was built. The arbiter ran all **13/13 assignments successfully**:

| Cases | Observed decision |
| --- | --- |
| Separate functions in one file; two readers of a shared utility | Both grants allowed |
| Overlap; utility provider/consumer in either order; renamed re-export; transitive inventory; stored-order contract | Second grant blocked |
| Shadowed callback; computed promotion dispatch | Unresolved dependency refused |
| Valid new import after checkout | Scope expansion required; no publication |
| Malformed JavaScript; valid cents-to-dollars contract break | Validation refused; no publication |

Fifteen separate adversarial producer cases passed, covering shadowing, shared-property
mutation, native-method replacement, unbound references, an irrelevant `typeof` check,
eval, malformed/invalid syntax and cyclic re-exports. These are fresh producer tests;
the 35 added Node regressions separately check frozen evidence/admission, stale hashes,
coverage omissions, scope caps, false raw edges, ownership/expiry and altered returned
checkout bytes.

Publication checks used independently tested behavior, not a validator returning true.
Two checkouts of separate functions in `pricing.mjs` added comments on their own bases.
The first published, the second three-way merged, both edits survived, and the current
graph revision matched the published source bytes. A new checkout then submitted a
change in the other function; it was refused as outside its grant and the head stayed
unchanged. Candidate graph construction precedes admission, and new dependencies must
already be in the issued protection set. No automatic scope expansion is implemented.

Coverage remains deliberately limited. Native runtime intrinsics are assumed unmodified;
string `trim` needs the supported AST short-circuit or throwing guard. General JavaScript
control flow, getters/proxies, runtime callback targets and executable strings are not
semantic-impact guarantees. `refunds.reduce` remains unresolved: an isolated
`refundableBalance` checkout is conservatively refused, and a static caller may be refused
as well. The corpus's stored-order case has a known contract conflict first. Explicit
contracts are trusted operator assertions, protected by source hashes and independent
behavior validation, not automatically discovered truths. No absence-of-interference or
useful-benefit claim follows from these selected cases.

The full Node 26 suite passed **838/838**, retained in
`artifacts/checkout-graph-node26-tests.tap`; repository boundary/link and whitespace
checks passed. No model or deployed-product trial ran.

State and checkout copies remain in memory. The producer, validator, participant identity
and clock are trusted local inputs. Matching code/graph publication is synchronous in
this process; restart/crash recovery, authenticated durable grants, async validation
races, idempotency, atomic scope expansion, disk working copies and deployed integration
remain open in slices 3-6. The observation profile retains its no-claims contract.

Reproduce on Node 26, using a fresh output directory each time:

```sh
npm run checkout:qualify -- --python=/private/tmp/ingress-graphify-venv/bin/python \
  --repo=/Users/ladmin/WebProjects/checkout-arbiter-lab
```

For another isolated environment, install `graphifyy==0.9.62`, `tree-sitter==0.25.2`
and `tree-sitter-javascript==0.25.0`, and pass that environment's Python. This command
runs no model, installs no hooks, and does not modify the standalone source repository.


### Comparative mechanism result

The subsequent [frozen comparison](checkout-comparison-protocol.md) ran 108 assignments,
36 per arm, with all outcomes retained. Current rules completed 30/36 missions correctly;
block scopes completed 24/36; graph scopes completed 22/36. The graph recovered four
stale-read-sensitive cases but refused twelve otherwise completed missions because new
imports require unavailable scope expansion and callback targets remain unknown. Two
reverse-order dependent reports still became wrong after their completed provider
changed. Passing the 13 admission oracles therefore does not imply improved mission
completion. See [comparison results and limits](checkout-comparison-results.md).
No live models, durable grant service or deployed integration were exercised.

## Source-control design input (2026-10-13)

Anthropic's [Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control)
describes immutable, content-addressed changesets, thin clients and sparse working
copies. Creating a changeset is separate from moving a shared ref, which uses a
compare-and-swap operation. Its dependency/history indexes are derived data. At their
scale, they also rely on post-merge/pre-deploy testing and repair instead of a global
merge-queue lock. This is an internal system for unusually large, online workloads,
not a generally available Git replacement or evidence for dependency checkout grants.

Our inference is to separate cheap proposal capture from validated publication to an
approved tip. Private copies and immutable source identities fit that design. Broad
transitive dependency exclusion should remain an experimental policy rather than an
assumed default. Keep Git compatibility and this repository's coordination boundary;
the article does not justify rebuilding a source-control ecosystem.

The next mechanism to qualify is versioned dependency evidence at publication, together
with invalidation of already-published dependent outputs after a provider changes.
Publication-time read checks alone cannot solve the completed-consumer/later-provider
failure observed in our deterministic study. An invalidated output must lose its current
validation status and be regenerated or revalidated before it can be treated as approved.
Graphs should be source-bound derived data with explicit coverage and unknowns; incremental
recomputation is a performance direction, not an implemented capability. Targeted exclusion
may still be appropriate for particular hazards. Unknown semantic coupling remains unknown.

This is design input, not an implemented architecture change. The admitted varied native
study keeps its original tasks, mechanisms, graders and budgets; its operational continuation
is recorded in the [protocol](checkout-varied-protocol.md#interrupted-execution-and-bounded-continuation-2026-10-13).
