# Checkout arbiter lab

A standalone deterministic order-and-fulfillment application for testing dependency
graphs, checkout scopes and submission validation. It uses Node built-ins only, with
no Stow, OpenCode, model service, provider credential or runtime package dependency.

The application prices a cart, applies discounts, serializes an order, captures its
payment, reserves stock, formats a receipt and issues refunds. Public catalog values
and hand-calculated behavioral expectations make the source useful as an independent
test corpus rather than just a collection of graph-shaped functions.

## Run

Use Node 26 or later; no package installation is required:

```sh
npm test
npm run demo
npm run manifest
npm run replay
```

`manifest` prints exact source hashes and a content revision, without needing a Git
commit. `replay` applies each of the three frozen candidate edits to disposable copies
under ignored `artifacts/`, retaining every log and outcome. It demonstrates:

- A new dependency can compile and pass the existing behavior checks yet require an
  expanded checkout scope because another participant is changing the new dependency.
- Malformed source fails syntax and behavior checks.
- A textually valid cents-to-dollars change fails the independent order/payment contract.

Replay does not invoke Ingress or certify any arbiter's decisions.

## Corpus and evidence

Index only `src/` for the structural graph. The code contains renamed imports, a
re-export barrel, distinct same-named format functions, shared configuration/utilities,
a callback that shadows an imported function, and computed promotion dispatch.

[contracts.json](contracts.json) supplies two explicit data contracts. Import/call
analysis alone cannot establish all relationships across serialized orders and receipts.
An adapter may ingest these separately as versioned, evidenced contract records.

[test/checkout-cases.json](test/checkout-cases.json) freezes 13 prospective checkout
scenarios. **This file is oracle-only: never ingest it into the graph or arbiter as
dependency evidence.** It distinguishes allow, block, unknown, scope expansion and
validation refusal. Unknown callbacks/dispatch require a declared conservative scope
or refusal; similarity or absent graph edges cannot establish independence.

[test/behavior.test.mjs](test/behavior.test.mjs) verifies actual workflow outputs and
contracts. [test/corpus.test.mjs](test/corpus.test.mjs) verifies that oracle scopes,
contract symbols and mutation anchors still refer to the baseline source.

Suggested comparison: private copies plus merge, whole-file grants, and validated
graph-backed block grants. Measure missed interference, unnecessary exclusion,
correctness, waiting and successful concurrent progress. Keep every assigned scenario,
including failures and unresolved outcomes. No embedding inference is needed.

## Optional Graphify probe

With Graphify 0.9.62 installed in an isolated environment:

```sh
graphify extract src --code-only --no-cluster --out artifacts/graphify
```

Successful extraction is not a grant-readiness signal. Validate physical symbol ranges,
lexical bindings, parse errors, source hashes and coverage before interpreting edges.
The `sendCustomReceipt(receipt, notify)` parameter deliberately shadows the imported
`notify`; the call is to the supplied parameter, not necessarily the imported function.

This is a synthetic qualification corpus. Passing it does not establish production
isolation, complete dependency coverage or useful benefit for real agent teams.

License: [Apache-2.0](LICENSE).
