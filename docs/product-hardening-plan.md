# Ingress product hardening and adoption plan

**Date:** 2026-10-04. **Status:** ordered work queue for the deployed product surface
(`src/product/`, `src/worker.js`, `product/wrangler.jsonc`). Every item is open.

No RT status advances. Nothing here qualifies a capability claim; the items below
either remove a way to defeat the fence or add a way for a stranger to reach it.
Scope note: the harness in `src/*.mjs` (probes, squads, benchmarks, overseer,
dashboards) and `examples/` are outside this queue. They are not product surface and
they are not where the risk is.

## How to read this

Priority is **consequence if unfixed**, not effort. Effort is listed per item because
the top four are one-file changes and the queue is not effort-ordered.

Each item carries the same four fields:

- **Now** — what the code does today, with `file:line`.
- **Change** — the specific work, named where it lands.
- **Verified by** — the test or command that must fail before and pass after.
- **Done when** — the condition that closes the item.

P0 is live exposure. The deployment recorded in [container-commit-report](container-commit-report.md)
answers on a public `workers.dev` hostname and authenticates nobody, so P0 is not a
code-hygiene tier.

| # | Item | Tier | Effort | State |
| --- | --- | --- | --- | --- |
| 1 | Authenticate the router | P0 | S | done |
| 2 | Stop forwarding `/internal/*` from outside | P0 | S | done |
| 3 | Bound `/start` | P0 | M | caps observed + injection fixed; **three defects found by running it** — a failing participant got a 500 and lost its verdict, `MAX_CONCURRENT_STARTS = 2` was fiction, and the run ceiling bounded the wait but not the work. All fixed; the launcher now kills its own command. Command surface open |
| 4 | Remove the unleased `/write` path | P1 | S | done |
| 5 | Remove the self-reported `/read` path | P1 | S | done |
| 6 | Align the launcher-trust claim with the code | P1 | S | done |
| 7 | Fix lease lifetime against participant runtime | P2 | M | done |
| 8 | Put the cross-boundary path under test | P2 | M | done |
| 9 | Make `/internal/gate-log` unwritable from outside | P2 | S | done (by item 2) |
| 10 | Model workspace ownership | P3 | M | done — **buys attribution, not squat prevention**; see the item |
| 11 | Package the client | P3 | M | open |
| 12 | Usage signal, cost ceiling, then billing | P3 | L | **usage + ceiling done and verified live**; billing not built — needs a price |
| 13 | Make the fence survive a swarm | P0 | M | **scoping, concurrency and content-per-revision done** (`e2e:swarm`, `e2e:concurrency`, `e2e:content`); **the trial says the swarm use case is not reachable as deployed** — no model inside the container; **output visibility shipped**; merge deferred to the trial's number |
| 14 | Qualify graph-backed block checkouts and publication | P1 | L | user-directed 2026-10-12; Graphify qualification 37/38, false target under parameter shadowing; AST ranges measured; graph eligibility guards and durable integration open; **versioned publication evidence and dependent-output invalidation qualified in the experiment scope (2026-10-22)**; product-side evidence recording still open |

Item 14 is a user-directed addition to this ordered queue. Its exclusive modification
grants belong to the managed checkout profile. The observation harness retains its
no-file-claims contract. This addition does not advance RT status or make the older
recorded deployment observations current again.

## Already recorded as a limit

These are not discoveries. They are recorded in this repository and are prioritised here.

| Recorded limit | Where | Item |
| --- | --- | --- |
| No auth on the public surface; `/start` spends account time | [container-commit-report](container-commit-report.md) honest limits | 1, 3 |
| Reads are still self-reported | [container-commit-report](container-commit-report.md) honest limits | 5 |
| No authentication; "a proof of mechanism, not something to expose" | [workspace-fence](workspace-fence.md) honest limits | 1, 3 |
| Auth and a rate limit on `/write` are not done | [workspace-fence](workspace-fence.md) not done | 1, 4 |
| A participant can modify the launcher | [container-commit-report](container-commit-report.md) honest limits | 6 |

The gap between "recorded as a limit" and "fixed" is the whole of P0 and P1.

## Not consistent with the recorded design

Three findings contradict what the code comments and reports assert. These are new.

1. **The gate-only routes are publicly reachable.** `src/product/workspace-agent.mjs:26-28`
   and `src/product/gate.mjs:1-19` both state that `/internal/commit` is reached
   exclusively through the platform-intercepted egress from the container. The router
   forwards any sub-path of `/w/:name/*` (`src/worker.js:59-77`), including
   `/internal/commit` and `/internal/seed`. Observed against the live deployment:
   `POST /w/<name>/internal/commit` from outside returned `403 no_token_issued`,
   which proves the route is externally reachable. The token check held; the
   exclusivity claim does not. Item 2.
2. **`/write` is a second write path that skips leases.** `src/product/workspace-agent.mjs:167-180`
   calls `ledger.admit()` directly, and `admit` takes no lease and never reads the lease
   table (`src/product/fence.mjs:295-372`). The lease requirement lives only in the gate
   path (`src/product/handlers/commit.mjs:74-96`). Item 4.
3. **The default lease is shorter than a plausible task.** `DEFAULT_LEASE_MS` is 60,000
   (`src/product/lease.mjs:63`); the launcher runs the participant command to completion
   and commits afterwards (`src/product/launcher.mjs:85-89`); the commit refuses without a
   live write lease (`src/product/handlers/commit.mjs:74-96`). Item 7.

## P0 — live exposure

### 1. Authenticate the router

**Now.** `src/worker.js:59-77` forwards every sub-path of `/w/:name/*` to the Durable
Object with no credential check, and stamps `x-ingress-workspace` from the URL rather
than from the caller (`src/worker.js:69`). Twelve routes are reachable by anyone who
knows or guesses a workspace name: `/join`, `/intent`, `/read`, `/write`, `/receipts`,
`/content`, `/state`, `/leases`, `/lease/checkout`, `/lease/heartbeat`,
`/lease/release`, `/lease/retrieve`, `/bootstrap`, `/start`. The only credential in the
product is the per-container token, checked on two of those routes
(`src/product/handlers/commit.mjs:28-36`, `src/product/handlers/commit.mjs:203-210`).
Workspaces are addressed by a name with no owner, so there is nothing to authenticate
against yet.

**Change.** Mint a workspace capability token when a workspace is created. Require it on
`/w/:name/*` in `src/worker.js`, before `stub.fetch`, and reject without touching the
Durable Object. Carry it in the same three headers the gate already uses
(`src/product/gate.mjs:25-27`) so there is one credential shape in the product. Pair
with item 10 for ownership.

**Verified by.** A new test in `test/product-workspace.test.mjs` that calls every routed
path with no token and asserts 401/403, not 200. The existing route-coverage probe
(`test/product-workspace.test.mjs:556-586`) is the list to extend.

**Done when.** No route reachable through the public worker returns 2xx without a valid
workspace token, and the container token remains the only credential inside the gate.

**Landed, pending deploy.** The decision is `src/product/router.mjs`, a pure module,
because `src/worker.js` imports `cloudflare:workers` and cannot be loaded under Node —
the check would otherwise have been a security boundary with no test over it.
`src/worker.js` now only asks `decide(request, env)` and performs the forward.

Behaviour, all asserted in `test/product-router.test.mjs`:

- `/w/:name/*` requires `x-ingress-workspace-token`; missing is 401, wrong is 403.
- An unset or non-string `WORKSPACE_TOKEN` refuses **closed** with 503, so a
  deployment that forgot its secret is visibly broken rather than quietly open.
- The credential is deleted from the forwarded headers; it does not travel into the
  Durable Object.
- The comparison reuses `tokensMatch` (`src/product/keys.mjs:43`), not `===`.
- `/health` stays credential-free and discloses nothing about credential state. An
  earlier draft reported `workspaceAuth: 'absent'`, which turned the one unauthenticated
  route into a way to detect a deployment that forgot its secret; that is withdrawn.
- `WWW-Authenticate` names the `Token` scheme, not `Bearer`, because the credential is a
  header rather than an `Authorization` bearer.

Callers updated: `WorkspaceClient` takes an optional `token` and sends it on every
request, and `scripts/commit-e2e.mjs`, `scripts/lease-e2e.mjs`, and
`scripts/seed-e2e.mjs` read `INGRESS_WORKSPACE_TOKEN` and refuse to run without it.
That variable name is deliberate — `INGRESS_TOKEN` already means the per-participant
container token (`src/product/handlers/container.mjs:50`), and reusing it would grant
participant identity as workspace identity.

**Deployed and confirmed.** Secret set and code uploaded; the live deployment was probed
with all three credential cases and every route:

```
GET /health                                200  {"ok":true,"service":"ingress-workspace"}
GET /w/<name>/state   no credential        401  {"reason":"missing_workspace_token"}
GET /w/<name>/state   wrong credential     403  {"reason":"workspace_token_mismatch"}
GET /w/<name>/state   correct credential   200  full ledger
```

All sixteen workspace sub-paths answer 401 without the credential, including
`/start`, `/bootstrap`, `/internal/seed`, and `/internal/gate-log`. `/nope` is still
404 and discloses no credential state.

The secret is a 32-byte random value generated for this purpose and written to a
`0600` file outside the repository. It is in no file, no log, and no commit. Rotate it
by setting a new value and redeploying.

**Also found while doing it.** `scripts/workspace-e2e.mjs` was already broken,
independently of this item: it called `WorkspaceClient.observe`, deleted deliberately in
`src/product/workspace-client.mjs:133-142`, and threw at module load. It also used
`/write`, which item 4 removes. Rather than rebuild a weaker duplicate of the scenario
`scripts/commit-e2e.mjs` already runs against real containers, the file now exits
non-zero and points there.

### 2. Stop forwarding `/internal/*` from outside

**Now.** The router builds its target from the caller's sub-path with no allowlist
(`src/worker.js:59-77`). `/internal/commit`, `/internal/seed`, and `/internal/gate-log`
are therefore reachable from the internet. The first two are token-checked; the third is
not checked at all (`src/product/workspace-agent.mjs:131-133`), so anyone can append
audit entries. The gate's stated topology — a participant cannot publish a byte it did
not send here — does not hold against a caller who is not a participant.

**Change.** Refuse the `/internal/` prefix in `src/product/router.mjs`, after the
credential check and before any forwarding headers are built.

**A refusal, not a marker scheme — the plan was wrong about the shape of the fix.** It
proposed a marker the platform interceptor sets and a browser cannot forge. That is
unnecessary, because a container's egress never reaches this router:
`container.interceptAllOutboundHttp(ctx.env.GATE)` sends all container traffic to the
`CommitGate` WorkerEntrypoint, which resolves the Durable Object stub itself and calls
`/internal/commit` on the object directly (`src/product/gate.mjs:81-132`). The public
router is not in that path. No e2e script requests `/internal/*` over HTTP either.
Forwarding it served nobody; it only let a credential-holder reach the gate's routes
from the internet.

The guard is a leading-segment prefix, not a substring match, and the difference is
asserted: `path.includes('internal')` would also refuse `/state/internal-summary`,
`/content/internal`, and `?path=internal/…`. Nothing is exploitable there today, but the
router would be pre-empting the routing table, which is how a later route breaks
silently. A workspace named `internal-demo` is untouched — the name is not the path.

Refusal is **404, not 403**, so it does not confirm the routes exist. Verified in
production by the response body: `/internal/commit` returns the router's
`{error: not_found, routes: […]}` while `/state/internal-summary` returns the object's own
`{error: route_not_found}` — so a caller cannot tell refusal from an unrouted path.

**Verified by.** Three mutations, each caught: the guard removed (the exact pre-item-2
state), the guard weakened to a substring match, and the 404 downgraded to a 403. Plus a
structural guard asserting the interception still exists, because if container egress ever
started arriving at the public router, this change would break every commit.

**Done when.** The exclusivity claim at `src/product/gate.mjs:1-19` is true as written,
or the claim is rewritten to the narrower thing the code does.

### 3. Bound `/start`

**Now.** `src/product/handlers/container.mjs:44-55` starts a `standard-1` Cloudflare
Container running a caller-supplied `participantCommand` with `enableInternet: false`,
and `:57` blocks on `container.monitor()` until the command exits. Unauthenticated and
unthrottled, this is arbitrary command execution plus unbounded spend on the account
holder's billing. The egress interception (`src/product/handlers/container.mjs:43`) and
the token mint (`:26-27`) are sound; the problem is that anyone may invoke them.

**A shell injection was found here, in the same route and the same request body.**
`workDir` was interpolated into the launcher script as `WORK='${workDir}'`. A workDir of
`'; echo INJECTED; #` closed the quote and ran whatever followed, as root, before the
participant command was even read. `participantCommand` was already passed through the
environment specifically to prevent this (`src/product/launcher.mjs:51-53`); `workDir` was
missed. `workDir` is no longer a parameter of `launcherScript` at all — it arrives as
`INGRESS_WORK_DIR` and the script reads `WORK="${INGRESS_WORK_DIR:-/workspace}"`.

**Caps landed.** The decision is pure and lives in `src/product/start.mjs`, because
limits that exist only as `if` statements in a handler are untested limits. It runs
before anything is created — a refusal mints no token, registers no participant, and
writes nothing, asserted against storage rather than by status code alone.

| Bound | Value | Why |
| --- | --- | --- |
| `participantCommand` length | 4 KiB | A real task is a few hundred bytes |
| `workDir` shape | absolute, no traversal, no metacharacters | Defence at the boundary, not only in the launcher |
| `runMs` | ≤ 15 min, must be a safe integer | A command that never exits held the request open and billed indefinitely |
| concurrent starts | **1** per workspace | Measured: `ctx.container` is one container per Durable Object, and a second `start()` is refused by the platform with a 500. Was 2, on the argument that the product's scenario has participants overlapping — sound argument, false premise. **The overlapping-participants scenario cannot happen on this runtime.** |

Two bugs in this work were caught by its own tests before deploy. The `workDir` pattern
used the charset `[A-Za-z0-9._-]`, which looks safe and admits `/workspace/.` and
`/workspace/../..` — a segment made only of dots needs excluding explicitly. And `runMs`
was parsed with `Number()`, so the string `'60000'` was accepted where the contract says
a number. A third was caught in review: the refusal spread the caught `Error`, which
copied its `name` and leaked the class name into the HTTP response.

Slot bookkeeping is stored (`keys.startsKey`), not held in memory, because a Durable
Object can be evicted between requests and an in-memory counter would reset to zero and
reissue the full quota on every cold start. A slot is taken **before** the container
starts, or two concurrent starts would both see a free slot, and released by expiry
value rather than by position, so two finishes in an unpredictable order cannot release
each other's slot. An abandoned slot expires rather than blocking the workspace forever —
which matters because an eviction mid-run leaves no holder to clean up.

**Verified by.** 24 behavioural tests plus 9 mutations of the caps themselves, each
broken on purpose and required to be caught: traversal guard weakened to permit dot-only
segments, guard dropped entirely, `runMs` ceiling removed, `runMs` string coercion, byte
cap removed, concurrency cap removed, expiry removed, wait made unbounded, and the
stop of an overrunning container removed. The unbounded-wait mutation initially hung the
suite rather than failing it, so the guards now carry their own 2s bound — a guard that
can hang cannot report that the property it checks is gone. One guard was also found to be
vacuous and rewritten: it asserted on a returned array that is empty under the mutation
too, and now asserts the observable difference, whether an abandoned slot refuses.

Confirmed in production after deploy — all 409, none reaching a container:

```
workDir "'; echo INJECTED; #"   invalid_work_dir
workDir /workspace/../..        invalid_work_dir
workDir /workspace/.            invalid_work_dir
workDir /work$(id)              invalid_work_dir
no participantCommand           missing_participant_command
runMs 99999999                  invalid_run_ms  limitMs 900000
runMs "60000"                   invalid_run_ms
missing participantId           invalid_participant
```

**Still open — the command surface.** Holding the workspace credential means holding the
right to run code, as root, on the account holder's machine. The caps bound how much, not
whether. Restricting `participantCommand` to a registered command name is a real product
decision: it changes who can use this and how, and it would break every e2e script, each
of which passes a bespoke shell command. It is not a security fix and should not be
adopted as one. Deliberately not done here without that decision.

**Verified by (remaining).** The 15-minute ceiling and `container.stop()` have not been
observed on a live container — `waitBounded` calls `stop` only if the runtime provides it,
because the container API's shape could not be verified from here. A command that overruns
in production has not been run, because that means paying for 15 minutes of container.

## P1 — the fence does not yet mean what it claims

### 4. Remove the unleased `/write` path

**Now.** `POST /write` (`src/product/workspace-agent.mjs:167-180`) calls
`ledger.admit()` and saves. `admit` has no lease parameter and never consults the lease
table (`src/product/fence.mjs:295-372`); the lease requirement is enforced only in the
gate path (`src/product/handlers/commit.mjs:74-96`). So `/write` is a weaker second write
path that bypasses leases, and it admits a revision for content it never stores — leaving
`/state` reporting a revision that `/content` answers 404 for. Unauthenticated, it lets a
caller bump revisions on any file and fire `dependency_moved` at every other participant.

**Change.** Route deleted from the Durable Object, and `WorkspaceClient.write` /
`tryWrite` / `WriteRefused` deleted with it. The client methods had to go rather than be
left to fail: a client advertising a method the server does not serve names the
capability at the front door and 404s every caller, which is the same mistake `/observe`
already taught this repository. `WriteLeaseRefused` replaces `WriteRefused` for callers
that catch a commit refusal.

**The blast radius was larger than this plan recorded.** `/write` was also the client's
only write path and the only thing `demoParticipant` demonstrated. Two consequences:

- `demoParticipant` no longer writes. It arrives, declares, reads, and returns the
  workspace's own account of that read. This is not a reduction in what the product can
  do — landing bytes requires a lease, a seed, a container and the gate, which an HTTP
  client could not do honestly — but it is a change to what a stranger sees first. Its
  first draft returned the envelope captured *before* the read, so it reported
  `yourReadRevision: null` and could not show the read it had just recorded; it now
  re-joins after reading.
- **The client can no longer land work at all.** It has no lease methods either. That is
  correct — the gate owns writes — but item 11 cannot ship "a stranger can use this"
  until lease checkout, release and heartbeat are on the client. Recorded, not deferred.

**Fence tests converted, not deleted.** Six tests drove `admit` over `/write`. They now
call `WorkspaceLedger.admit` directly, which is a better test: the decision is exercised
without a router, a storage shim and a Durable Object in between. Eviction moved to the
same direct call against a freshly mounted instance, which is the property an eviction
could lose.

**Verified by.** Two new tests. One asserts `/write` is unrouted and that a direct `admit`
records exactly one receipt, so the route is gone rather than merely unreachable. The
other asserts the done-when structurally instead of by grep: `workspace-agent.mjs` must not
contain `ledger.admit(` at all, and the gate must read the lease table *before* calling
`evaluateCommit`. A third asserts the client's routes and the workspace's route table
agree, derived from both sources rather than hardcoded, so a route added to one and not the
other fails here. `/write` and `/observe` sit in the router's unreachable list so a
regression restoring either fails.

Confirmed in production: `POST /w/<n>/write` and `POST /w/<n>/observe` both answer 404
`route_not_found` from the object.

**Done when.** `grep` finds no route that admits a write without a lease check. Met:
`admit(` has zero callers in `src/` outside `fence.mjs` itself.

**New finding, not yet actioned.** With `/write` gone, `WorkspaceLedger.admit` has **no
production caller**. The live write decision is `evaluateCommit` (`commit.mjs:154`), which
reimplements the same four checks — terminal participant, stale base, stale dependency,
unknown read — without lease knowledge, and adds `no_change`, which `admit` lacks. So the
fence has two decision implementations and the one carrying 18 test call sites is the one
that does not run. Reconciling them is not small and is not started; logged so it is not
lost.

### 5. Remove the self-reported `/read` path

**Now.** `/read` (`src/product/workspace-agent.mjs:203-213`) records a read the caller
asserts, and `readBasis: 'verified'` in the decision cut rests entirely on that assertion
(`src/product/fence.mjs:264-285`). This is the weakest remaining link in the product's
central claim, and it is already recorded as a known limit in
[container-commit-report](container-commit-report.md).

The lease layer supersedes it. `checkout` returns the actual bytes and the workspace is
the party handing them over (`src/product/handlers/leases.mjs:111-137`); `seed` serves
exactly the leased tree (`src/product/handlers/leases.mjs:238-303`). A participant holding
a read lease has been given the content by the workspace, so the read record is a weaker
duplicate of a stronger mechanism.

**Change.** Delete `/read` and derive the read record from the live read lease. Remove
`WorkspaceClient.read` and its retry dance in `demoParticipant`
(`src/product/workspace-client.mjs:152-166`).

**Verified by.** The existing `dependency_read_unknown` and `dependency_moved` tests must
still pass with reads derived from leases. Then mutate: make the lease grant skip
recording the read, and confirm a refusal test fires.

**Done when.** No path exists by which a caller asserts its own read, and
`readBasis: 'verified'` is derived from a workspace-side grant.

**Change.** `/read` deleted from the Durable Object and `WorkspaceClient.read` deleted
with it. `handlers/leases.mjs` now records the read inside `checkout`, for every path in
the granted closure and for **both** modes — a write lease is also a handover, so whoever
holds a file for writing has been given its content too. Recording only for read grants
would mean the holder of a file had no basis for it, which is the opposite of the truth.

A read is now a consequence of a fact (the workspace handed these bytes over, at these
revisions) rather than a claim about one. That is the whole item.

**The client gained `checkout` and `release`,** because with `read` gone a client had no
way to establish a basis at all, and `checkout` without `release` is a trap: a read lease
is exclusive against a write, so a caller that took one and did nothing else would block
every writer until it expired. `demoParticipant` now demonstrates the honest version of
the product's claim — arrive, declare, ask for the file, receive the actual bytes and the
recorded revision — rather than asserting a read and being believed.

**A lease interaction the plan did not predict, which the tests surfaced.** With reads
derived from grants, the fence's own stale-write scenario became *unreachable* in tests:
while the reader holds a read lease, nobody else can take a write lease, so step 4 could
never be reached. The lease layer was working correctly. Two helpers now release what
they take, modelling what a real participant does — a container commits and exits — and
the read record survives release because it lives in the ledger rather than the lease
table. That separation is precisely what makes a stale write detectable afterwards.

**Verified by.** Six new tests. The core one asserts `readBasis` is `unknown` before any
handover and `verified` with `readRevision` 1 after a grant. Another asserts a write lease
also establishes the read. Another asserts reading a path nobody has written yields
`readBasis: 'unknown'` — you cannot have read a file that does not exist, and the strict
direction is preserved. Two assert `/read` and `/observe` are unrouted and that the client
has no `read` method. All nine prior `POST /read` setups across two test files were
converted to grants rather than deleted, so no coverage was lost.

Confirmed in production:

```
join, before handover      yourReadRevision: null   (unknown)
POST /read                 404 route_not_found
POST /lease/checkout       granted, revision 1, bytes "v1"
join, after handover       yourReadRevision: 1, stale false
```

**Done when.** Met: `recordRead` has exactly one caller in `src/`, and it is the lease
handler.

### 6. Align the launcher-trust claim with the code

**Now.** A participant is root in its own container and the reporter is a writable file
on the same filesystem, so it can rewrite the program that reports its changes
(`src/product/launcher.mjs:14-20`). A real fix needs a second reporter the participant
cannot reach, and the current topology has nowhere to put one.

**Change.** Decide and record. Either find a location the participant cannot write, or
state the enforceable property precisely at every site that currently implies more.

**No unreachable location exists,** so this closes by stating. Every claim is now split
into what holds *regardless of the reporter* and what depends on it unmodified. Three
sites overstated the guarantee, and in each case the weaker truth was sitting two lines
below the stronger claim:

| Site | Claimed | Actually true |
| --- | --- | --- |
| `launcher.mjs:14` | "The workspace cannot be fed a fabricated file list" | A replaced reporter produces the list, so it can be fabricated |
| `commit.mjs:19-20` | a participant "cannot forge a file's content" | It cannot store bytes under a mismatched hash. It can send content it never wrote |
| `gate.mjs:11` | "cannot publish a byte it did not send here" | True about routing, misleading if read as truth about the sender |

`commit.mjs` was the important one, because that module is what does the verifying. Its
claim of a single lie direction was also wrong: substitution is a second direction, once
the reporter is replaceable.

**What is genuinely enforced regardless of the reporter**, now stated at each site: the
workspace stores the bytes it received and recomputes the hash on arrival; a participant
cannot reach another workspace; a participant cannot act as another. These are properties
of the receiving end, not of the code that sends.

**What depends on the reporter:** the file list being truthful, the bytes having been
written to the container filesystem at all, and nothing having been omitted.

**The asymmetry, stated honestly.** Both available directions — substitution and omission
— cost the participant its own work rather than another participant's correctness,
because the fence decides from revisions the workspace itself holds. What a participant
cannot get is its work believed: every admission and refusal is receipted.

Also recorded, per item 4: `fence.mjs` now says on `admit` itself that nothing in `src/`
calls it, that `evaluateCommit` is the live decision, and that its 18 test call sites are
therefore *not* evidence about production behaviour. `commit.mjs` carries the reciprocal
note. [container-commit-report](container-commit-report.md) honest limits were stale — it
still listed self-reported reads, no auth, and did not mention the duplication — and now
match the code.

**Verified by.** No test; this item closes on the text matching the mechanism, which is
checked by reading. What *is* tested, and was added under item 4, is the adjacent
mechanical version of the same claim: `workspace-agent.mjs` must not contain
`ledger.admit(`, `recordRead` must have exactly one caller, and the router must refuse
`/internal/`. Those fail if the claims stop being true.

**Done when.** The claim in the code matches the mechanism in the code.

## P2 — the core loop breaks on real work

### 7. Fix lease lifetime against participant runtime

**Now.** Default lease 60 s (`src/product/lease.mjs:63`, capped at 15 min at `:64`); the
launcher runs the participant to completion and commits after (`src/product/launcher.mjs:85-89`);
the commit refuses without a live write lease (`src/product/handlers/commit.mjs:74-96`).
Any task over a minute loses its lease and is refused with `lease_required`. The e2e
scripts work around this by leasing for 300,000 ms (`scripts/commit-e2e.mjs:53-59`), which
means the workaround is invisible to anyone reading the default.

**Decision taken: option (a).** The user said "Continue" after being offered both, having
been recommended (a), and I read that as taking the recommendation rather than as a fresh
decision. Recorded here rather than left implicit, because (a) widens the gate by two
routes and that is not a choice to make by silence. Reversing to (b) means deleting the
renewer and its two gate routes; nothing else depends on it.

**Change.** `/start` now issues the write lease and the container is the holder.

- `POST /start` accepts `writePaths`. Validated in `decideStart` — workspace-relative,
  bounded per path and per request, deduplicated (`src/product/start.mjs`). Omitted means
  exactly the previous behaviour, so no existing caller changes.
- The grant happens **before** the token is minted and before `container.start`, so a
  `lease_conflict` has created nothing at all. It goes through `grantWrite`
  (`src/product/handlers/leases.mjs`), which is the same grant `checkout` performs minus
  the content read, and records the read a write lease implies.
- The lease id travels to the container as `INGRESS_LEASE_ID`, with `INGRESS_LEASE_MS` the
  duration *granted* and `INGRESS_RENEW_INTERVAL_MS` a quarter of it
  (`RENEW_INTERVAL_MS`, `src/product/lease.mjs`).
- The launcher runs the reporter in a fourth mode, `--renew`, as a background process for
  the length of the command, and a fifth, `--release`, after the commit.

**Two design points worth stating, because both were decisions rather than mechanics.**

1. **The lease stays at 60 s rather than being stretched to cover the run.** The renewer
   makes that viable, and keeping it short keeps recovery fast: a container that dies
   holding a file blocks others for one lease period, not for a 15-minute run. The
   alternative — one long lease, rarely renewed — makes work safe and recovery slow, which
   is the wrong way round for a workspace where participants overlap by design.
2. **The renewal interval is fixed by the workspace, not chosen by the container.** A
   caller that could send a shorter `leaseMs` would shorten its own expiry on the first
   heartbeat and lose the lease mid-run. The launcher sends back exactly what it was
   granted. `grantWrite` returns the *duration* rather than the expiry, because deriving
   it from `expiresAt` loses the milliseconds spent between the grant and building the
   environment.

**The gate grew from two routes to four**, and that is the cost of the decision:
`/lease/heartbeat` and `/lease/release` now reach the Durable Object, allow-listed in
`PERMITTED` (`src/product/gate.mjs`) so a route added to the object is not automatically
added to the gate. Both are token-checked by `authenticateContainer`
(`src/product/container-auth.mjs`, extracted so the commit, seed and both lease routes
share one check rather than three copies), and both refuse a lease id belonging to another
participant. Neither admits a byte; `/internal/commit` is still the only route that does.

**Verified by.** Offline: the reporter's `--renew` and `--release` modes are executed for
real against a stub gate — the granted duration is sent back verbatim, a refusal ends the
loop rather than being retried, an unreachable gate is not treated as a refusal, and a
container with no lease never posts at all. Plus, on the Durable Object: a container cannot
renew or release another's lease, a renewal cannot revive a lapsed one, and a
start-issued grant is atomic and durable.

Live: `scripts/commit-e2e.mjs` step 7 runs `sleep 75` — a quarter-minute past the 60-second
default — and asserts the commit lands *and* that the lease is free immediately afterwards.
A unit test cannot cover this, because the bug is the interaction of two clocks.

**Observed on the deployment:**

```
--- 7. a command that outlives the lease still commits
  ran for 84s (default lease is 60s)
  status 200 | admitted: true | reason: commit_admitted
  landed from-d.txt@r1
  from-d.txt still leased after the run: no, released
live leases remaining: 0
VERDICT: A 84s COMMAND OUTLIVED THE 60s LEASE AND COMMITTED
```

84 seconds, because container boot counts against the run and the sleep was 75.

`live leases remaining: 0` is the line that proves the release rather than the commit. Four
participants ran containers, every one of them wrote files, and at the end nothing is held —
with no `POST /lease/release` anywhere in the script except the read-lease helper, which is
how a dependency is read. An earlier run of this same step reported `0` only for
`from-d.txt` while two harness-managed leases were still held, which is exactly what the
number would look like if the launcher's release did nothing and those two were simply
never released.

The `leaseMs: 300000` that this bug forced onto every lease call in that script is gone
from all four places, along with the three explicit releases that existed only because the
harness had to manage the lease itself.

**Done when.** A participant command longer than the default lease commits successfully.

**Test-harness faults found while building this**, recorded because each one produced a
guard that passed or failed for the wrong reason:

- Four write-path guards were written as ordinary tests rather than entries in `GUARDS`, so
  the mutation pass never ran them against a broken `start.mjs` — all four mutations
  "survived".
- A guard read `m.MAX_LEASE_PATHS` from the mutated module, which does not re-export it.
  `undefined + 1` is `NaN`, `Array.from({length: NaN})` is empty, and the guard was
  asserting that an empty list is refused.
- The renewer tests measured their window from the spawn. Node startup under the full
  suite's parallel load is long enough that the window expired before the reporter had
  parsed its arguments, so `npm test` failed where the file passed alone. The window now
  starts from the reporter's own first line of output.
- Two sync tests asserted on a `Response`'s `.body`, which is a stream, and one read
  `snapshot().reads`, which does not exist — `reads` is in `toJSON` only.

### 8. Put the cross-boundary path under test

**Now.** The container path has no automated coverage. CI runs `npm test` and
`npm run check` only (`.github/workflows/ci.yml`), and `scripts/commit-e2e.mjs`,
`scripts/lease-e2e.mjs`, `scripts/seed-e2e.mjs`, and `scripts/workspace-e2e.mjs` are not
in `package.json` scripts, so they are run by hand against a paid account. The class of
bug this misses has already shipped: `manifestVersion` crosses the process boundary as an
environment variable, arrived as `"1"`, and every real commit was refused with 422 while
the in-process tests passed (`src/product/manifest.mjs:36-42`,
[container-commit-report](container-commit-report.md) bug 5).

**Change.** Two steps, both done. First, offline: `test/product-launcher.test.mjs`
executes the real `CONTAINER_REPORTER` string under Node in a child process with `fetch`
stubbed, so the whole manifest contract is asserted from the container side with no
account. Second, live: all three working e2e scripts were run against the deployment.

**The offline half needed one production change to be possible at all.** The reporter
hardcoded `REVISIONS_PATH = '/tmp/ingress-revisions.json'`, so it could only ever run
inside a container — the one place it is hardest to observe. It is now
`INGRESS_REVISIONS_PATH`, defaulting to the original.

**Running it for the first time outside a container found two real defects:**

1. **The reporter's self-exclusion was dead code.** It compared `rel` — the path relative
   to the work directory — against `REVISIONS_PATH`, which is absolute, so it never
   matched. Harmless only because the file lives in `/tmp`, outside the walked tree, which
   is a coincidence rather than a guard. Now compared as resolved absolute paths; it would
   have begun committing the workspace's own bookkeeping the moment that path moved
   inside the tree.
2. **A backtick in a comment broke the module.** `CONTAINER_REPORTER` is a template
   literal and the file says so at its own definition. Quoting an identifier in a new
   comment terminated the literal, and the module failed to parse with an error pointing at
   unrelated code. There is now a test asserting the string parses as a function body.

**Twelve tests**, each covering a contract that previously had none: the seed's three
gate headers and the absence of the workspace credential from container traffic; content
written from the grant; an absent path staying absent; the manifest's version (a string,
because it crosses a process boundary), sorted relative paths, `baseRevision` attached only
for seeded files, and hashes matching the bytes on disk; a lost revisions file announced
as `INGRESS-BASE-UNKNOWN`; symlinks never followed; an oversized file reported as `skipped`
rather than dropped; bookkeeping excluded; and a non-zero participant exit reaching the
gate.

**The live half found a third defect, and only a real container could find it.**
`commit-e2e.mjs` step 6 failed: C could not re-read `engine.mjs` because B still held the
write lease. C's re-read used to be `POST /read`, which ignored leases entirely and so
never hit this — item 5 exposed it. Fixed by having B release, as a finished participant
does, and the script now asserts C's re-read lands on revision 2. That is the second time
this script needed a release added, and it is itself the finding: **the lease exclusivity
is real and every caller must respect it**, and nothing in the test suite could have said
so.

**The core claim is now observed rather than asserted** — for the first time in this
queue, from a real container on real infrastructure:

```
A was handed engine.mjs at revision 1, by creator
A committed from inside a container     -> admitted, from-a.txt@r1
C was handed engine.mjs at revision 1
B rewrote engine.mjs in a container     -> admitted, engine.mjs@r2 by B
C committed from that stale read        -> REFUSED dependency_moved
                                           engine.mjs readRevision 1, currentRevision 2, author B
C's file landed?                         NO (fence held)
C re-read -> was handed revision 2, by B
C committed the identical work          -> ADMITTED, from-c.txt@r1
VERDICT: THE FENCE HELD ON CLOUDFLARE
```

`lease-e2e.mjs` and `seed-e2e.mjs` also pass end to end, observing the parts of the lease
layer that had only been unit-tested: a reader excluded by a writer, a heartbeat keeping a
lease alive, `retrieve` refusing a live lease and recovering an expired one with
`reclaimedFrom` naming the dead holder, and a lapsed lease caught by `lease_required`
before the fence is consulted.

**Not done, deliberately.** The scheduled workflow that would run these in CI is still
absent — it needs a repository secret, and a pull request from a fork cannot reach one.
Running the e2e scripts remains a manual, paid step.

**Item 3's caps are now observed on the deployment**, by `scripts/start-bounds-e2e.mjs`
(27/27), and doing that closed the last "still unobserved" item in this plan — but not the
way the plan expected. It found the ceiling does not do what it says.

### The run ceiling does not stop anything

**Measured, on the deployment, not read from source.** A `sleep 30` with `runMs: 1000`:

```
{"participantId":"p1","started":true,"timedOut":true,"participantExit":null,"commit":null}
--- immediately after, start 2:
{"error":"start() cannot be called on a container that is already running."}   HTTP 500
```

Twenty-five seconds later, once the command finished on its own, the same start succeeded.

`container.stop` does not exist on this runtime. `waitBounded` guarded the call with
`typeof stop === 'function'`, which is why nothing crashed — and the comment beside it
asserted the container "is stopped", which was true of the code and false of the platform.
So:

- **`MAX_RUN_MS` bounds how long the caller waits, not how long the work runs.** An
  overrunning command keeps running and keeps billing, and it holds its workspace's
  container slot until it finishes on its own.
- **The caller cannot tell the difference from the response**, which is what made this
  worth fixing rather than noting. `timedOut: true` read as "the command ended". It did
  not. The correct response differs: with the container unstoppable a caller must wait or
  abandon the workspace, not retry — and retrying is exactly what the platform punishes
  with a 500.

The product cannot supply a missing platform method. What it can do is stop claiming, so:

- `waitBounded` returns `stopAvailable` and `stopError`, measured per call. A `stop` that
  throws is reported as not-stopped rather than swallowed.
- `/start` returns `stopAvailable` beside `timedOut`, and says in the response what a
  `false` means.
- The comment at `waitBounded` states the measurement and what it rules out.

Three guards and three mutations, including one that breaks the *reporting* of a stop that
never happened — which is the regression that matters on this deployment.

**A second defect, found the same way, in the ordering of two statements.** A `/start`
refused for `lease_conflict` left the participant **registered** in the ledger. No token,
no container and no lease — but a permanent roster entry for a participant that never ran,
visible in `/state`, with no way to remove it. `ledger.register` ran before the grant, and
on refusal nothing rolled it back.

It had to be that way: `grantWrite` records the read a write lease implies, and
`recordRead` calls `require()`, which throws for someone who has not joined. So the fix
was not to swap two statements, it was to give `grantWrite` the registration. The handover
is the decision, and the decision is about who is working as well as what they are working
on. One writer of the roster instead of two callers guessing at its order.

**Item 3's caps are now observed on the deployment**, by `scripts/start-bounds-e2e.mjs`,
and doing that closed the last "still unobserved" item in this plan — and found three defects
that reading the source had not.

### `MAX_CONCURRENT_STARTS` was fiction

The same script, one step later, produced a third finding, and this one is a product
limitation rather than a reporting problem.

`MAX_CONCURRENT_STARTS` was **2**, on an argument recorded in the source: the product's own
scenario has participants overlapping — an agent builds while a human edits the dependency it
reads — and one would serialise the workspace into a queue, which is the failure mode the
lease layer exists to avoid.

`ctx.container` is **one container per Durable Object**. A second `start()` on a live one is
refused by the platform:

```
{"error":"start() cannot be called on a container that is already running."}   HTTP 500
```

So the argument about serialisation was sound and the premise was false. Every unit test
passed with the value at 2, because the cap is our bookkeeping and the constraint is the
platform's — and only running two overlapping participants against the deployment could find
it.

Two changes, and neither is optional:

- **`MAX_CONCURRENT_STARTS` is 1.** The honest number. The overlapping-participants scenario
  the product was designed around **cannot happen on this runtime**, and that is a product
  limitation rather than an implementation detail.
- **`container.start` is wrapped**, so a platform refusal becomes a 409 `container_busy`
  with a hint, and the slot and lease are released on that path. A cap that cannot be
  honoured must not surface as a 500: the caller reading "busy, wait" and the caller reading
  a platform error string need different responses.

The `seed-e2e.mjs` step that depended on two overlapping participants was rewritten rather
than worked around. Its real claim — a lapsed lease is refused — does not need them, and its
final check had been **vacuous**: it asserted the content did not contain `'slow'`, which is
true when the file is untouched, which is what happened when the second participant silently
failed to start and nothing landed at all. It now asserts the file is byte-for-byte `v1` and
still at revision 1, which is the claim the step was making.

### The unbounded-cost hole, and its fix

The two findings above compose into something worse than either, and it is the reason the
rest of item 3 was worth finishing.

`container.stop` does not exist, so an overrunning container is never stopped.
`MAX_CONCURRENT_STARTS` is per-workspace and a workspace name is chosen by the caller.
Therefore **one authenticated request could start a container that ran indefinitely and
billed indefinitely.** `MAX_RUN_MS` bounded how long the caller *waited*; nothing bounded how
long the work *ran*. There was no ceiling on spend at all.

**Fixed at the only place that can fix it — inside the container.** `timeout(1)` was measured
present in the image (`/usr/bin/timeout`, `/bin/sh` is dash, uid 0 — probed by running it,
not assumed), so the launcher now runs the participant command under:

```
timeout -k "$INGRESS_KILL_GRACE_SECONDS" "$INGRESS_RUN_SECONDS" sh -c "$PARTICIPANT_COMMAND"
```

- **`-k` escalates to SIGKILL** after `KILL_GRACE_SECONDS`. Without it, a participant that
  ignores SIGTERM is the same hole with extra steps — the escalation cannot be conditional on
  good manners.
- **The bound wraps the participant only**, never the launcher. Wrapping the script would
  bound the seed and the commit too, so an overrunning participant could be cut off between
  finishing its work and reporting it — losing the work with no trace.
- **`timeout` exits 124**, which is the only signal that the work was cut short rather than
  finished. A container killed by its own launcher exits long before the workspace's
  deadline, so `timedOut` is `false` in exactly the case a caller most needs to know about.
  `/start` therefore reports `commandTimeout` alongside it.
- **If `timeout` is absent from an image, the launcher says so** (`INGRESS-NO-TIMEOUT`)
  rather than quietly running unbounded. An image without it is back to the caller being the
  only bound, and that should be legible in the participant log.
- **The bound is rounded up** to whole seconds. Rounding down would give the command less
  than the caller asked for, which is the platform quietly changing the terms.
- **`INGRESS_RUN_SECONDS` is a real value, not a computed one at the boundary** — the
  workspace rounds, so the shell is not doing arithmetic on a number it was handed.

**Two clocks, and the gap between them was the hole.** The launcher's bound runs from when
*it* starts — after container boot. The workspace's deadline runs from when it called
`start()` — before boot. So the container outlives the wait by the boot duration, and the
workspace would free its bookkeeping while the container kept running. The workspace now
waits `runMs + EXIT_GRACE_MS`, so it stops watching only once the container has certainly
exited. The cost is that a caller asking for a 15-minute run waits up to 16; the benefit is
that `timedOut` means the work is over rather than that we stopped watching it.

This makes `stopAvailable: false` far less consequential than it was — the container now
terminates itself — but it is still reported, because it is still true and the image could
change.

**Observed**, `runMs: 20000` against `sleep 300`:

```
{"participantId":"forever","started":true,"timedOut":false,"participantExit":124,
 "commandTimeout":true,"containerError":"Container exited with unexpected exit code: 124",
 "commit":{"admitted":true,"reason":"commit_empty","participantExit":124,"landed":[]}}
elapsed=22s
```

Twenty-two seconds instead of three hundred, and — the line that closes the hole — the
**very next `/start` in the same workspace succeeded immediately**. The container is gone
because it terminated itself, not because anything stopped it.

Note `timedOut: false` with `commandTimeout: true`. That is not a contradiction: `timedOut`
is about the workspace's *wait*, which did not expire, and `commandTimeout` is about the
*work*, which was cut short. Both are reported, because a caller asking "did my work finish?"
needs the second and asking "was I cut off?" needs the first.

### Three checks that passed while the workspace was refusing everything

Worth recording, because the failure was in the checks rather than the product:

```js
console.log(`... -> ${slotsFree.status} ${slotsFree.body.reason ?? 'started'}`);
expect('the slot was released', slotsFree.body.reason !== 'too_many_concurrent_starts');
```

A **500** carries no `reason`, so the fallback supplied `'started'` and the comparison was
`'started' !== 'too_many_concurrent_starts'` — true. Three consecutive checks passed that
way while every `/start` in the workspace was failing. **A check whose fallback is the
value it is looking for cannot fail.** Statuses are now asserted directly and a reason is
never used as a fallback.

The same script also mixed cases that could not share a workspace: step 6 leaves a container
that cannot be stopped, and that container owns the workspace until it finishes, so steps 8
and 9 were failing for a reason unrelated to what they tested — one of them reported a lease
conflict as `too_many_concurrent_starts`. Each step group now has its own workspace, rather
than the alternative of sleeps, which would be a test passing for a timing reason.

### The worst bug in the queue: a failing participant got a 500

Found while proving the bound above, and it is the one that matters most.

`container.monitor()` **rejects** when the container exits non-zero. Nothing handled the
rejection, so it propagated out of `waitBounded`, out of `/start`, and the route answered
**500**:

```
{"error":"Container exited with unexpected exit code: 3"}
```

The command had done real work first — `out.txt` was **admitted at revision 1** — and the
caller received no exit code, no commit verdict and no receipts, on a status that says the
server broke.

That is the worst possible shape for a failure *in this product specifically*. An agent that
works and then fails is exactly the case the receipts exist to explain, and `lastContainerExit`
exists on purpose to record "a container that crashed after doing real work". Both were
unreachable on the single path that produces the crash. Every e2e script passed because every
participant command exited 0.

Fixed in `waitBounded`: the rejection is caught and carried as `containerError`, and `/start`
answers 200 with the exit status, the verdict and the receipts. A failing participant is an
outcome, not a server error. Observed after the fix:

```
{"participantId":"failer","started":true,"timedOut":false,"participantExit":3,
 "commandTimeout":false,"containerError":"Container exited with unexpected exit code: 3",
 "commit":{"admitted":true,"reason":"commit_admitted","participantExit":3,
           "landed":[{"path":"out.txt","revision":1,...}]}}
```

Two guards and two mutations. One mutation had to be written twice: the first version
replaced the opening `started.then(` and left the argument list orphaned, so the mutated
module failed to *parse* and the test reported a syntax error rather than a surviving guard.
**A mutation that breaks the parse is testing the parser.**

### One transport fix, in one place

`start-bounds-e2e.mjs` died on its second request with
`ConnectTimeoutError ... timeout: 10000ms`. That was undici's default against a cold edge —
the first `/health` probe of the session measured 22 seconds, the next three 0.13s. All four
e2e scripts had their own `post`/`get` with no timeout, so the fix would have been the
fourth copy to carry the bug. It is now `scripts/e2e-client.mjs`: one client, 90-second
timeout, retrying **only transport failures** — a request that provably reached nobody. A
4xx or 5xx is returned as-is, because re-sending one would repeat a refusal the caller needs
to see, or boot a second container. `commit`, `lease` and `seed` now use it, each losing its
own `BASE`, `auth` and credential check.

### 9. Make `/internal/gate-log` unwritable from outside

**Now.** Routed at `src/product/workspace-agent.mjs:131-133`. Unauthenticated appends
would make the audit trail worthless, which is the one thing the trail is for.

**Change.** Covered by item 2, which refuses the whole `/internal/` prefix. Confirmed in
production: `POST /w/<name>/internal/gate-log` with a valid credential answers 404.

**Done when.** Only the gate writes the log.

## P3 — required before anyone else can use it

### 10. Model workspace ownership

**Now.** A workspace is a name in a URL resolved by `idFromName`
(`src/worker.js:62`) with no owner and no creator. Anyone can read one, seed one, or
pre-empt a name before its owner initialises it (`src/product/handlers/bootstrap.mjs:19-27`
refuses only a second bootstrap, not a first one by a stranger).

**Change.** Item 1 is the mechanism. Add the ownership record: who created the workspace,
which token administers it, and refuse `/bootstrap` on a name whose token was never
presented by its creator.

**Verified by.** A test that bootstrapping a workspace with the wrong token is refused,
and that a second bootstrap with the right token is still refused for the existing reason.

**Done, and it does less than the item claimed.** The plan framed this as closing a
name-squat hole: anyone holding the deployment credential can bootstrap any name, and the
genuine owner is then locked out by `bootstrap_closed`. **It does not.** Whoever bootstraps
first becomes the owner, because the credential is shared. What it buys is attribution and a
stable owner identity. Preventing the squat needs per-caller credentials, which is a product
decision and is the same family as item 3's command surface.

The first bootstrap now mints a workspace token, returns it once, and stores only its digest
(`ownerKey`, `digest`/`digestHex`/`bytesToHex`). A later bootstrap must present it: 403
`not_workspace_owner` without, 409 `bootstrap_closed` with. A workspace holding files with
no owner record — one from before this change — is refused as `workspace_exists_unowned`
rather than adopted, because adopting hands it to whoever asks next.

**Three traps in the verification, each of which made the check do nothing while looking
correct:**

- `new Uint8Array(hexString)` yields an **empty array** rather than throwing. Both digest
  sides went zero-length, the comparison loop never ran, `diff` stayed 0, and `tokensMatch`
  returned **true for every input including the empty token**.
- `String(arrayBuffer)` is `"[object ArrayBuffer]"`. Comparing a *stored* digest against a
  fresh one hashed that literal on one side. `digestHex` (hash then encode) and `bytesToHex`
  (encode what you already have) now exist separately, each documenting which mistake it
  causes — the first fails **closed** (locks the owner out), the second would have failed
  **open**.
- `tokensMatch` takes two *raw* credentials. Handed the stored digest it hashes it a second
  time, which can never match — safe, but it locks the owner out of their own workspace.

And one test bug of the same shape as the others: `await asJSON(await post(...)).reason`
binds `.reason` to the `Response`, which has none, so the comparison inspected `undefined`
and passed.

**A test that asserted the wrong attack.** "A stranger cannot bootstrap an *empty* workspace
someone else created" is unreachable — `/bootstrap` with zero files is refused as
`empty_commit`, so an owned workspace always holds at least one file and the ledger rule
alone would refuse. Replaced with a test asserting that consequence, which is the honest
version and which is what bounds the feature's value.

### 11. Package the client

**Now.** `package.json` is `private`, has zero dependencies, no `bin`, no install script,
and no deploy script. `product/wrangler.jsonc` pins the author's `account_id`, sets
`workers_dev: true` and `preview_urls: true`, and points `main` at `../src/worker.js`.
A buyer must read the config to learn that they need their own Cloudflare account, and
must clone the repository to obtain a client that already exists in
`src/product/workspace-client.mjs`.

**Change.** Publish the client from `src/product/workspace-client.mjs` as a package with
a `bin`. Add a thin CLI over `demoParticipant` (`src/product/workspace-client.mjs:152`).
Add a deploy path so `account_id` is supplied rather than committed.

**Verified by.** `npm pack` from a clean clone installs and runs the CLI against a
deployed worker in one command. Record the exact command here.

### 12. Usage signal, cost ceiling, then billing

**Now.** No billing code exists anywhere in the repository. The only record of user
behaviour is the per-workspace gate log, bounded to 100 entries
(`src/product/keys.mjs:21`) and readable by no one, since the read route was removed
(`src/product/workspace-agent.mjs:134-139`). There is no aggregate of what workspaces
exist, how often they are used, or what they cost.

**Change.** In this order: a workspace counter and a cost ceiling per workspace (which
item 3 makes enforceable); then an aggregate of workspaces created, commits admitted and
refused, and lease conflicts; then billing. Billing last because it is worthless until
P0 makes the deployment safe to sell.

**Verified by.** The counter is visible on an authenticated route and the ceiling refuses
at the bound. Billing has no test here; do not add one that mocks a payment provider.

**The first two legs are done and verified on the deployment.** `src/product/usage.mjs` is a
pure module — the arithmetic is tested without an account — and `GET /usage` serves it,
authenticated like every workspace route.

Counted: starts, run-seconds requested, commits admitted / refused / empty, lease conflicts,
bytes admitted, first and last seen. The ceiling covers **starts** and **cumulative requested
run time**, because those are the two things that bill. Commits and lease conflicts are
counted but deliberately do not gate: a workspace being refused a thousand times a second is
one whose callers are confused, and cutting it off there would hide the confusion rather
than fix it.

Four decisions that are the feature rather than the plumbing:

- **A refused start consumes no quota.** The difference between a ceiling and a counter. A
  counter that increments on refusal lets a caller lock themselves out by retrying, and the
  resulting error is indistinguishable from the one that locked them out. Verified live: three
  refusals, `starts` still 0.
- **The counter is cached on the instance**, like the ledger and the lease table, because a
  Durable Object can be evicted between requests and a counter that resets on eviction is not
  a ceiling. Verified by reading `/usage` from a cold instance over the same storage.
- **A record missing a newer counter folds in as zero, not `undefined`.** `undefined` in a sum
  is `NaN`, and `NaN` compares false against every ceiling — so a workspace whose record
  predates a field added later would be permanently under its limit and the counter would
  never work again.
- **Nonsense env values fall back to the default, never to infinity.** `MAX_STARTS=0` by
  mistake should be bounded, not refusing every start with a configuration error.

Observed on the deployment with the ceiling set to 2 so the bound was reachable in one run:

```
start 1 -> 200 | usage.starts 1
start 2 -> 200 | usage.starts 2
start 3 -> 429 | cost_ceiling | limit starts | used 2 of 2
usage after -> {"starts":2,"exhausted":true,"remaining":{"starts":0,...}}
a refused start consumed quota? no
```

**The defaults are a placeholder and say so.** `DEFAULT_MAX_STARTS = 500` and
`DEFAULT_MAX_RUN_SECONDS = 100_000` are not derived from a price. What is defensible is the
reasoning: each start is a container, a container bills for as long as it runs, and with the
15-minute run ceiling one start can cost a quarter-hour. The numbers are a starting bound, set
in one place, and the constants carry the caveat so whoever changes them reads it.

**Billing is not built, and this is the reason to stop rather than a scheduling note.** It
needs a price for a container-minute on this account, which is not something the repository
knows and not something I should guess. The counters now give you the numbers such a price
would be applied to; that is the whole of what this leg can honestly deliver.

Three defects found while wiring it, two of them in my own tests and one in production code
that only a live call reached:

- `ceiling()` was added to the agent and never to `ctx`, so **every `/start` answered 500**
  `ctx.ceiling is not a function`.
- `/start`'s own lease conflict was not counted, only the public `checkout` path — a workspace
  refused once per start would have reported zero conflicts.
- Three test bugs: `/join` is GET-only (written as POST), `/start` needs the
  `x-ingress-workspace` header the router normally stamps, and `call(coldInstance(...))` —
  the exact mistake that helper's own comment warns about.

### 13. Make the fence survive a swarm

Not in the original plan, and it should have been first.

**What prompted it.** The owner described the actual use: *agents building out in a swarm, and
if left alone they end up with 50 git merge issues.* That is a threat model this entire
document had backwards. Every question above asked "can a stranger holding the token do
damage?", and the answer was yes — arbitrary root on the account holder's machine. The real
requirement is several **trusted** agents editing one repository without tripping over each
other. Those need opposite fixes.

**What was wrong.** Dependencies were declared once per participant at `/join` and held for
that participant's whole life, and `evaluateCommit` applied that single list to **every file
in a commit**:

```js
const stale = cut.reads.filter(entry => entry.stale === true);
if (stale.length > 0) { refusals.push({ path: file.path, reason: 'dependency_moved', ... }); }
```

So one stale dependency refused files with no relationship to it. In a swarm, the first agent
to move any shared file blocks every other agent's entire commit. The comment above it —
*"nothing it produced can be trusted, including files that are themselves fine"* — is
defensible for a participant doing one thing and exactly wrong for one doing fifty.

That is not conflict prevention. It is a barrier, and the pressure a barrier creates is what
makes people reach for `--force`, which is worse than the merge conflicts the fence exists to
prevent. **The fence would not have prevented the 50 merge conflicts; it would have caused a
deadlock that made `--force` look reasonable.**

**The fix.** A manifest entry declares what *it* was built from:

```js
builtFrom: [{ path: 'engine.mjs', revision: 1 }]  // scoped to this file
builtFrom: []                                     // built from nothing
// absent                                         // fall back to the coarse check
```

Absent falls back rather than dropping the check, so adopting scoping is opt-in and cannot
loosen anything silently. Every refusal carries `dependencyBasis: 'per_file' |
'participant_declared'` so nobody has to guess which rule ran. A declared input that **does
not exist** counts as stale — otherwise `builtFrom: [{path: 'never-written.mjs', revision:
0}]` is a way to declare immunity.

Reachable from a container via `.ingress/built-from.json`, which the reporter reads and
attaches. It lives under `.ingress/` because that is already ignored by the walk, so a
participant cannot smuggle provenance in as a file change.

**Observed on the deployment** (`npm run e2e:swarm`, 18/18):

```
B declares no inputs and writes something unrelated
  PASS  B is admitted — A landing does not block an unrelated agent

C declares it was built from engine.mjs@r1
  reason: dependency_moved | dependencyBasis: per_file
  staleDependencies: [{path: engine.mjs, readRevision: 1, currentRevision: 2, author: A}]
  PASS  only the file that declared it is refused

two agents want engine.mjs at once
  E -> 409 lease_conflict | blockedOn: ["D"]
  PASS  no commit verdict is invented for a start that never happened
```

The `author` in the refusal is what makes it actionable: an agent can tell "this was a race,
re-read and retry" from "find out what A did".

**Two live bugs found on the way, both pre-existing:**

- **`ALWAYS_IGNORED` was dead code.** Exported from `manifest.mjs` and documented as "files
  the workspace never commits, whatever a participant says" — and applied by nothing, in
  neither the reporter's walk nor `parseManifest`. A participant who ran `npm install` or
  `git init` sent the entire tree and the workspace stored it. Now applied on both sides,
  with a test asserting the reporter's inlined copy matches the canonical list — because it
  runs in a container and cannot import.
- **`verifyCommit` silently dropped `builtFrom`**, rebuilding each file object without it, so
  the first version of the scoping did nothing and every commit fell back to the coarse path.
  Caught by a test asserting `per_file` and receiving `participant_declared`.

#### Leg 2 — concurrency

**What was wrong.** One container per workspace, so the swarm was sequential. This was the
binding constraint on the actual use case, and it was a genuine conflict rather than an
oversight: the fence needs one Durable Object to decide in a single turn against current
state, and `ctx.container` is one container per Durable Object. Buying both from one object
means paying for serialisation with the same coin as safety — and serialisation is the thing
that stops a swarm from being a swarm.

**The fix.** Split the two roles.

- The **workspace** object is the **arbiter**. It holds the ledger, the leases, the tokens and
  the usage counters, and it makes every decision. It boots no container.
- An **executor** object (`src/product/executor.mjs`) owns exactly one container and makes no
  decision. It is handed a token the arbiter minted and a lease the arbiter granted, and it
  cannot widen either.

`/start` decides everything — bounds, ceiling, lease grant, token mint, slot allocation — in
one object in one turn, then awaits the executor. Awaiting a stub releases the arbiter's input
gate, so it can decide a concurrent `/commit` while a start is in flight. The gate already
resolved a workspace by name from a header, so a container started from *any* executor still
reports to the one arbiter that holds the ledger.

After the split there is still **exactly one place where a commit is decided**. That is the
property worth having; "we made it concurrent" is not a safety property on its own.

Cap is `INGRESS_MAX_CONCURRENT_STARTS`, default 4 — enough that a swarm is a swarm, small
enough that the concurrency is visible in the cost ceiling. Slots are `{slot, expiresAt}`
records allocated by `allocateSlot`, which is pure and tested; the old format was a bare array
of expiries and its entries are pruned rather than interpreted, because inventing a slot number
is how two starts get handed the same executor.

**Observed on the deployment** (`npm run e2e:concurrency`, 15/15):

```
a: 200 admitted=true   b: 409 too_many_concurrent_starts
c: 200 admitted=true   d: 200 admitted=true
e: 200 admitted=true
settled in 33s (sequential would be 150s)
```

**The 33s is the claim.** Four 30-second commands settling in 33 seconds is overlap. Capacity
alone does not show it: four *instant* commands finish just as fast whether they overlapped or
ran in sequence, which is why the first version of this check proved nothing — it printed
"each with a 60s sleep" while the commands contained no sleep at all, and the log line was the
only thing claiming concurrency.

**Two live bugs found by turning concurrency on. Neither was reachable while execution was
serial:**

- **A lost update on every counter.** Usage was folded as
  `saveUsage(recordX(await usage()))` — read the cached record, build a replacement, store it.
  Two of those interleaving on an `await` both read revision 0 and both wrote revision 1, and
  one increment vanished with no error anywhere. Five starts were counted as four.
  The contrast is why it was easy to miss: the ledger and the lease table are mutated **in
  place** on a shared instance, so interleaved callers accumulate on one object and the last
  save writes the union. Usage was written as immutable transforms, which is tidier and is
  exactly what made it unsafe. Now `addUsage` does the whole read-modify-write inside a
  storage transaction, and the three named helpers return *deltas* so intent stays at the call
  site, the `Math.ceil` rounding rule stays in one place, and there is exactly one mutator.
- **Slot release by expiry timestamp.** Two starts issued in the same millisecond shared an
  expiry, so finishing either freed both. Slots are now identified by number.

**One configuration fault reported as contention.** A missing `EXECUTOR` binding threw, and the
same handler caught that as a platform refusal — so a deployment that could start nothing at
all answered `409 container_busy`, and an operator would have gone looking at slots and waits
instead of at their own config. Found by a test shim with no executor, which answered 409 for
every start while appearing to test the caps. Now `501 no_executor`, naming the binding.

**Three tests were checking the wrong thing.** `product-start.test.mjs` compared the *positions
of substrings* in the handler — `decideStart(` before `crypto.randomUUID()` before
`container.start(` — which asserts that a file's text has a shape, not that a route behaves.
All three broke on the split for reasons unrelated to what they claimed. Replaced with
behavioural versions: a refused start mints no token, registers no participant, takes no slot
and delegates to no executor; a completed start leaves no slot; a deployment with no executor
answers 501.

#### Leg 3 — content-per-revision (the merge prerequisite)

**What was wrong.** `contentKey(path)` held exactly one version per path, overwritten on every
commit. Enough to decide *whether* a write is admissible, and completely enough to merge it: by
the time the second agent commits, the bytes it was handed are gone, so a 3-way merge has no
base and the only remaining answer is "refused".

For one participant doing one thing that is correct. For a swarm it is the whole problem — two
agents editing different functions of one file collide over a base neither of them is looking
at, and the refusal names the right reason and still leaves a human merging by hand.

**The fix.** Three keys per write, all in one storage `put`:

```
content:<path>              current content — what every existing reader already wants
content:<path>@<revision>   that revision, so a later merge has a base
content-index:<path>        which revisions are retained, and how many were dropped
```

`/content?path=X&revision=N` serves one revision; `/content?path=X` is unchanged and serves the
current one.

**Retention is part of the design, not an afterthought.** Content-per-revision is unbounded by
construction: `MAX_FILES` is 512 and `MAX_FILE_BYTES` is 512 KiB, so keeping everything forever
is 512 × N × 512 KiB with no term. Each path keeps a bounded window — five revisions or 2 MiB,
whichever bites first — and **the count of what it dropped is retained**, the same rule
`receiptsTrimmed` follows. A trim that does not report itself is worse than one that admits it:
a caller asking "what was revision 3?" has to be able to tell "never existed" from "dropped, and
here is a merge you can no longer attempt". `findBase` returns `evicted` for that case and
**never substitutes a nearby revision** — the nearest retained revision is a plausible-looking
base that the participant never saw, and merging against it lands a file attributed to an agent
that did not write it.

**Three bugs, all found by tests written after the code:**

- **The byte ceiling was unreachable.** `retain` read it from a fresh `retentionFromEnv({})`
  rather than from its `limit` argument, so it only applied when the environment was *empty* —
  never in production, where every caller passes an env-derived limit. A ceiling that only
  applies in tests is worse than none: the test exercising it passes while deployed behaviour is
  unbounded.
- **One revision was dropped twice.** The trim cursor re-read `entries[0]` each pass instead of
  advancing, so the same revision went into `drop` twice: its bytes were subtracted twice, the
  loop stopped a revision early, and `trimmed` counted revisions that were never removed.
- **The mutation harness could not fail.** It ran the suite as a subprocess and asserted on the
  exit status — and `node --test` exits 0 even when tests fail, so all 14 mutations "survived".
  Two of them were in fact no-op edits: they replaced the condition of a ternary and left
  `(Infinity ? bounds.bytes : DEFAULT)`, which evaluates to the original value. Rewritten
  in-process, matching `router-auth-mutations.test.mjs`, and verified by inverting its own
  assertion: 14 failures when inverted, 0 when correct.

**What is still open, and it is the merge itself.** Nothing reads the revisioned keys yet — the
seed, `/content` and `retrieve` are untouched, and `applyCommit` still refuses a stale base with
`write_base_stale`. A line-based merge is a decision this layer should not make by itself: a
merge that is subtly wrong lands a file nobody wrote, which is worse than a refusal. What is now
true is that the base is retrievable, so the decision can be made and reviewed on its own
merits.

#### The trial: can this product host the swarm it exists for?

Run (`npm run trial`, `scripts/trial.mjs`). It measures the substrate, because something else
settles the more important question first.

**The container cannot reach a model — measured, not read.** A probe from inside:

```
api.anthropic.com -> 000      api.openai.com -> 000
example.com        -> 409     registry.npmjs.org -> 000
DNS resolves fine. env: only INGRESS_TOKEN.
```

`000` is connection refused; `409` is the gate, which answers anything that is not a workspace
route. `enableInternet` is false on top of that. **So there is no agent inside the product, and
the merge — the whole point of the swarm fence — would arbitrate the output of something that
cannot exist.**

And the sandbox itself is offline in a way that needs stating: the seed excludes
`node_modules`, and dependency fetching is impossible with `enableInternet` off, so every start
is a cold offline build. The model is only buildable against vendored or image-baked
dependencies.

What the trial measured on the substrate, and what it means:

```
concurrent / disjoint: 4/6 admitted   25s      2 refused too_many_concurrent_starts
serial     / disjoint: 6/6 admitted  190s
concurrent / shared:   1/6 admitted   31s      5 refused lease_conflict
```

- **Concurrency is real** — 190s down to 25s. It is not decorative.
- **One shared file costs five disjoint edits.** Each agent inserted at its own anchor line, so
  git would have merged all six; five did not land. That is the merge's ceiling, and it is a
  narrow one — it fixes the same-file case, and no other failure mode.

The architecture the trial supports: **the model loop lives outside, the container is a
deterministic build/test sandbox, and the fence arbitrates what lands.** Not what is built.

That model was unimplementable with the network closed, because `enableInternet` was false and
every external host's request returned 409 from the gate — the container could not fetch a
dependency, so no project whose `package.json` was not fully vendored could build. The posture
of 2026-10-05 v `5e5ed04b`, therefore:

- Container starts with `enableInternet: true`. The egress interception stays, but the gate
  now **proxies** non-`workspace.internal` traffic instead of answering 409 — preserving
  method and body, stripping the container's own Host header. Verified live:
  `npm install lodash` and `curl -sI https://example.com` both succeed from inside.
- What the gate now guarantees: every workspace route still goes through the allow-list and
  the participant's token, and every byte that lands in the workspace was admitted by the
  fence. What it no longer guarantees: that the container talks to nothing else. The old
  egress-wall argument is retired, because the sandbox model requires outreach.

The one cost that is now real, and not a footnote: `enableInternet: true` means a participant
can publish anything, including the workspace tree, to anywhere. The fence is a registry and
an audit of what lands; it is not a containment boundary.

#### Output visibility (the first gap the inversion exposed)

An external harness driving `/start` got back a commit verdict and an exit code — no output.
The launcher appended the participant's stdout to `/tmp/ingress-participant.log` and `cat`ed
it into a stream no route read. A failing build and a green one returned identical response
shapes.

Fixed: the reporter now carries the captured log (bounded, tail kept, its own field) in the
commit POST, the gate stores it, and `/start` returns it. Verified live — a command printing
`BUILD_OK` comes back in `log`. This is why the launcher date-stamped three times before a
failing build was diagnosable; it is now one.

#### The trial's limits

- The agents are scripted, not models. It measured contention and refusal cost, not output
  quality — a trial with real agents cannot run until the output gap above is exercised
  against a real agent harness, and the sandbox's offline constraint is acknowledged.
- `too_many_concurrent_starts` is the cap of four doing its job, not a defect.

**Next on this leg, not the same-file merge:** a real-agent trial through the output path.
Everything else this document asks about — whether the fence beats serial, whether a thinner
abstraction suffices, whether multi-file conflicts dominate — remains unmeasured, and that
is the right thing to measure next.


### 14. Qualify graph-backed block checkouts and publication

**Now.** The [checkout experiment](checkout-arbiter-prototype.md) grants revision-relative
line scopes, expands operator-declared dependencies in both directions, checks submitted
diffs, expires grants and merges compatible edits. It has 18 independent boundary checks
and a measured 11-case embedding comparison. Its state is in memory, its graph is a
hand-authored fixture and its identity/clock/validator are trusted local parameters.
It provides no authenticated durable checkout or private filesystem boundary.
The existing product already has authenticated routing, participant/container identity,
whole-file leases, revisioned content, a commit manifest and a text merge path. Those are
the integration seams; another independent production arbiter is not the intended result.
The subsequent [Graphify qualification](checkout-arbiter-prototype.md#measured-graphify-qualification)
scanned 24 product files and passed 37/38 checks. A falsely resolved parameter-shadowed
call, absent native end ranges and a successful populated graph for malformed input
require binding, span and parse-error guards before the graph can authorize grants.
The bounded lab adapter now implements those guards for its supported MJS subset and
ran the real in-memory arbiter against all 13 independent checkout cases, 15 adversarial
binding cases and concurrent publication/outside-scope checks. A later
[108-assignment comparison](checkout-comparison-results.md) found worse overall mission
completion in the current graph prototype: 22/36 versus current rules' 30/36. Missing
scope expansion, unknown callback exclusion and post-publication dependency invalidation
are measured usability/correctness gaps. This advances slice 2's
local experiment only; authenticated durable grants and deployment remain open. Dynamic
callbacks/methods still cause conservative refusal, including `refunds.reduce`.

**Change.** Execute the six slices in the
[implementation sequence](checkout-arbiter-prototype.md#implementation-sequence).
Qualify a pinned, code-only Graphify extractor first; normalize its output into a
revisioned, evidenced dependency index; extend the existing grant/content/commit
boundaries; then exercise actual private working copies and recovery. V1 uses structural
extraction and explicit evidenced contract records; embeddings are excluded from its
runtime path and their prior experiment remains retained. Stow remains
an optional public storage integration, never a private/sibling dependency.

The user-selected v1 profile enforces grants at submission/publication.
Preventing edits outside a grant inside a private working copy is a distinct stronger
profile requiring an enforced editor/filesystem boundary. The user-facing guarantee
must identify which profile ran. Source coverage, unresolved references and graph
freshness accompany every graph-backed decision.

**Verified by.** A real-repository extractor probe with independently checked JS/MJS
call/import relationships and symbol spans; model-free fixtures for normalization,
scope compatibility, restart/expiry/fencing and newly introduced dependencies; a
two-working-copy integration path proving out-of-scope submissions do not land and
compatible same-file changes survive. An async validation race must cause a retry,
never a publication based on an obsolete head. Crash probes must never expose a code
revision paired with the wrong graph. Reuse `npm test` and `npm run check` for each
landed product slice; retained live harness trials remain opt-in.

**Done when.** Authenticated participants can obtain a bounded immutable checkout,
work independently, request scope expansion, and submit through the existing admitted
write boundary. The arbiter derives provenance from its issued base and validated
index, not a participant's claim that it has no dependencies. A publication atomically
advances its workspace manifest and corresponding ready graph. Expired/revoked grants
and retries cannot publish twice. The independent campaign records correctness,
missed interference, needless exclusion, waiting and recovery for every assigned case.
Native edit prevention and useful benefit remain unqualified unless separately proved.

This addition brings managed checkout/base retention and graph publication into scope;
the older exclusions below still apply to a general Git replacement and to claims of
semantic merge correctness.

#### The invalidation increment (2026-10-22)

Slice 4 asks for "versioned dependency evidence at publication". That part is now
qualified in the experiment scope, and the finding that shaped it is worth recording
here because it changes what the product would have to build.

**The dependency relation the mechanism needs is not in the graph.** The case that
fails is a consumer that reads a policy value out of another module without importing
it. There is no import edge, so a graph-derived relation does not exist, and the
relation is precisely what invalidation compares. The evidence that works is the
participant's own declared inputs — the `builtFrom` this queue already introduced in
item 13 leg 1 — plus explicit contract records. **A product implementation that took
dependency evidence only from a code graph would not fire once on the measured
failure.**

**What the product would have to hold.** Per published output: the output's own
revision, the revision of each input it was built from, and the source of that
declaration. That is a publication record, not a fence decision, and it belongs with
the commit receipt rather than inside the admission path. The experiment implementation
is `src/prototypes/checkout/invalidation.mjs` and it is in-memory.

**What now exists in the product (2026-10-22, same day).** Slice 4's durable form is
implemented, offline-tested and **not deployed**:

- `src/product/invalidation.mjs` is the pure derivation. It holds no state: the
  invalidated set is recomputed from the ledger's own file revisions on every read, so a
  republish clears an entry because the evidence changed, not because something
  remembered to clear it.
- The ledger's file record now carries `evidence` — `{inputs: [{path, revision}], source}`
  — written by `applyCommit` at the moment of publication. `source` distinguishes a
  per-file `builtFrom` declaration from the participant-wide fallback, and `null` means
  nobody declared anything: that file is reported `uncovered`, never approved.
- `GET /w/:name/invalidated` (authenticated like every other read) returns the derived
  report: each invalidated output, its depth, the inputs that contradicted it and who
  moved them, plus the uncovered list.
- A commit that contradicts an output retains an `output_invalidated` receipt
  (`causedBy`, `depth`, `staleInputs`) and names the paths in its own outcome. The event is
  the *difference* the write made, so an already-invalid output is not re-announced.
- Transitive closure is included: an output built from an invalidated output is
  invalidated one hop further out, with the carrier named.

Two properties are asserted in tests rather than assumed, and both cut against the
convenient reading. A file is **not its own dependency** — the self-edge is dropped when
evidence is recorded, because a participant that read the file it is editing declares
exactly that, and keeping the edge would make every same-file edit invalidate itself on
landing. And an explicit `builtFrom: []` **clears** the status, because the relation is a
declaration and the workspace takes an explicit "I built from nothing" at its word —
the same way the fence already does at admission. That is the honest limit of a
declaration-based relation, which is why the record keeps the source and the author.

What has *not* changed: no route blocks a reader, nothing re-runs a participant, and
the deployment still runs the previous version. `evaluateCommit` already refuses a
*pending* write that declares a moved revision, so the two agree by construction and a
stale declaration cannot be laundered into health — but a participant that declares
nothing is still covered by nothing.

**What it does not do.** It does not make a stale output *wrong* — it makes the
workspace *say* the output is no longer approved. Restoring correctness is the
participant's work: revalidate or regenerate. The measured campaign shows the
mechanism converting six published-but-wrong missions per arm into correct ones under
a stated model of a worker that redoes its own work, at the cost of extra work ticks
and of invalidating dependents the change could not have affected. See
[the invalidation results](checkout-invalidation-results.md). No admission rule, durable
record, deployment or RT status changed by the experiment; the product slice above adds
a durable record and a read route, and still advances no RT status.

## Verification gates per tier

| Tier | Gate before closing the last item |
| --- | --- |
| P0 | Every public route refuses an unauthenticated caller; no `/internal/` route reaches a Durable Object from outside; `/start` refuses an over-long, non-terminating, over-concurrent or malformed request. Items 1, 2, 9 and the caps in 3 are confirmed deployed. **Not met:** item 3's command surface. **Superseded:** the interface question, because the threat model was wrong — a trusted swarm, not a stranger with the token — so item 13 is the P0 work that matters, and its three engineering legs are done. **Reframed by the trial:** no agent can exist inside the container, so the architecture is an outside harness driving a deterministic sandbox, and the same-file merge is deferred beyond the trial's number — five disjoint same-file edits did not land. |
| P1 | No write path admits without a lease check; no path exists by which a caller asserts its own read; the documented guarantee matches the mechanism. **P1 is complete.** |
| P2 | A participant command longer than the default lease commits successfully; a manifest-contract break fails without an account. **P2 is complete** — items 7 and 8, both observed on the deployment. |
| P3 | A clean clone installs the client and deploys without reading `product/wrangler.jsonc`; the cost ceiling refuses at its bound. **The second half is met** — the ceiling refused at its bound on the deployment, and `/usage` is visible on an authenticated route. Item 11 is open. |

Run `npm test` and `npm run check` at every tier. On Node 26 the suite is expected green;
the mission tests refuse to run below 26 and say so
(`src/mission-verifier.mjs:16-17`, `package.json` `engines.node`).

## Explicitly not in this queue

- **Snapshot isolation, or a second unreachable reporter** (item 6). Unavailable on this
  account; recorded in [snapshot-spike-report](snapshot-spike-report.md).
- **Clone, history, or merge.** The fence is the layer git lacks, not a replacement for
  it ([workspace-fence](workspace-fence.md) honest limits).
- **Durable Object storage as the byte substrate**, and any Artifacts wiring. Separate
  work; see [cloudflare-platform-plan](cloudflare-platform-plan.md).
- **The harness in `src/*.mjs`** — probes, squads, benchmarks, blind review, overseer,
  dashboards, missions. Roughly 5,000 lines and a large fraction of the repository's
  activity. Not product surface. Whether it should keep growing is a separate question
  this queue does not answer.
- **The harness test failures seen on Node 25.** Not a defect: the mission verifier gates
  on Node 26 and `package.json` declares it.

## Reproduce the findings

Read-only. Nothing here starts a container, mints a token, or writes to a workspace.

```bash
npm test                                     # 217/217 product tests; 10 mission tests need Node 26
npm run demo                                 # deterministic apparatus, verification true
npm run check                                # link and private-import boundary only; no lint, no typecheck
node --test test/product-router.test.mjs test/mutations/router-auth-mutations.test.mjs
node --test --test-timeout=25000 test/product-start.test.mjs   # caps and their mutations
```

Against the deployment recorded in [container-commit-report](container-commit-report.md),
substituting `<name>` for a workspace name you own. These are the confirmed results
after item 1 deployed.

```bash
curl -s $BASE/health                          # 200, unauthenticated, discloses nothing
curl -s $BASE/w/<name>/state                  # 401 missing_workspace_token
curl -s -H "x-ingress-workspace-token: wrong" $BASE/w/<name>/state
                                             # 403 workspace_token_mismatch
curl -s -H "x-ingress-workspace-token: $INGRESS_WORKSPACE_TOKEN" $BASE/w/<name>/state
                                             # 200, full ledger
```

The item 2 probe, with a valid credential. It answers the router's 404 rather than
reaching the object, confirmed deployed:

```bash
curl -s -X POST -H "x-ingress-workspace-token: $INGRESS_WORKSPACE_TOKEN" \
  -H 'content-type: application/json' -d '{}' $BASE/w/<name>/internal/commit
# {"error":"not_found","routes":["/health","w/:workspace/*"]}
```

Read the body to tell a router refusal from an object 404. `/internal/commit` returns
`not_found` with the route list; `/state/internal-summary` — which the router forwards,
because `internal` is not the leading segment — returns the object's own
`{"error":"route_not_found"}`.

For item 3, every one of these is refused at the router's successor in the handler and
none reaches a container:

```bash
curl -s -X POST -H "x-ingress-workspace-token: $INGRESS_WORKSPACE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"participantId":"a","participantCommand":"true","workDir":"'"'"'; echo INJECTED; #"}' \
  $BASE/w/<name>/start
# {"error":"refused","reason":"invalid_work_dir","workDir":"'; echo INJECTED; #", ...}
```

## Source coverage

Inspected in full: `src/worker.js`, all of `src/product/` (fence, lease table, commit
verification and evaluation, gate, launcher, manifest, keys, http, client, the Durable
Object and its four handlers), the six product test files, `package.json`,
`product/wrangler.jsonc`, `.github/workflows/ci.yml`. Skimmed for scope only: the
harness modules in `src/*.mjs`, `fixtures/`, `examples/canada-crossroads`, `scripts/`.

Ran: the product test files (287 passing, 0 failing — 68 for `/start` including 21
mutations, 22 router, 10 router mutations, 24 for the in-container reporter, 48 for the
workspace surface, and the fence, lease and manifest suites), the full suite (592 tests,
581 passing, 11 failing, all in the mission suite and gated on Node 26 while this machine
runs 25.9), `npm run demo`, `npm run check`, `node --check` on every script, `curl` against
the live deployment for every case in items 1 to 6, and — for items 3, 7 and 8 — all four
e2e scripts against the live deployment, which start real containers and cost a small
amount of account time.

The four scripts and what each one is now evidence for: `commit-e2e.mjs` — the fence holds
against a stale read, and an 84-second command outlives the 60-second lease with no lease
left held; `lease-e2e.mjs` — reader/writer exclusivity, heartbeat, `retrieve` refusing live
and recovering expired; `seed-e2e.mjs` — a participant sees the real bytes and a lapsed
lease is refused with the file untouched; `start-bounds-e2e.mjs` (30 checks) — every
`/start` bound, and an overrunning command killed by its own container.

The full suite is run after every item rather than only the product files, and that is not
ceremony: the item-7 renewer tests passed as a file and failed under `npm test`, because
their window was measured from the spawn and the reporter had not started. A guard only
verified against the load it will actually run under is not verified.

Refactoring the e2e scripts onto the shared client was verified by **running all of them**,
not by the unit suite — and two of the four failed on first run, for reasons that had
nothing to do with the product: a local helper returned the bare body while the shared one
returns `{status, body}`, so every `.commit` read `undefined`; and a step whose second
participant could not start because the platform allows one container per workspace, which
made its final check pass on a file nothing had written to. A harness that compiles is not a
harness that works, and only running it says which.

The mission suite is timing-sensitive — it spawns subprocesses under deadlines — and one
run reported 11 failures rather than 10 before two consecutive runs returned to 10. Treat
a single extra mission failure as possible flake, not as a regression.

Requires `--test-timeout` above ~25s for the mutation suite, because the unbounded-wait
mutation is caught by a guard that waits out its own 2s bound.

Verified against the live account for item 1: the secret is bound (confirmed via
`cf workers secrets list`), the code is deployed, and all three credential cases plus
every workspace sub-path were probed and match the unit tests.

Verified against the live account for items 1 to 6 and, under items 7 and 8, with **real
containers**: three e2e scripts ran end to end, committing, being refused, re-reading and
committing again, plus an 84-second command that outlived the 60-second lease and committed
anyway, leaving no lease held at the end. `WORK` read from the environment,
`container.monitor()`, the seed, the gate, the lease renewal and release inside the
container, and the refusal evidence are all observed rather than inferred.

Not verified: the run ceiling and `container.stop()`, which need a command that
deliberately overruns; the scheduled CI workflow, which needs a repository secret; and any
usage, cost or revenue signal, because no code produces one.

Could not verify, by choice rather than by blocker: Cloudflare billing behaviour, and what a
workspace costs at a given participant count. No credential, account identifier, or
deployment hostname is recorded in this document by intent — the deployment is identified
by the report that already owns it.

Documentation in this repository was not used as evidence for any judgement above. It was
read to avoid re-reporting a known limit as a discovery, and to record where this
evaluation contradicts a claim the code comments make. Every finding is anchored to code
or to an observed response.
