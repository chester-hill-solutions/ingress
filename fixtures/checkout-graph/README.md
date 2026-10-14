# Frozen binding evidence

These JSON records are versioned, source-hashed AST fixtures for the checkout experiment.
`bindings.json` was produced from the standalone lab's 16 source modules. The adversarial
records correspond to the independent cases in `scripts/checkout/binding-cases.mjs`.
Neither record includes the 13 checkout expectations as dependency evidence.
`expansion.json` contains source-bound seed, helper, dependency, unrelated-edit,
unknown-call and moved-head examples for atomic expansion regressions. The binding
counterexamples now include intrinsic shadows, contained helpers, reassignment and
single-parameter arrows. Historical campaign records retain their original producer
hashes; these current fixtures describe the revised producer.

Ordinary Node tests replay normalization/admission against these frozen facts and check
the current producer hashes; they do not launch Python, Graphify, Stow or a model. The
optional `npm run checkout:qualify -- --python=/path/to/isolated/python` run exercises
the actual producer again and retains every source, graph, decision and validation log.

Producer facts and explicit contract declarations are trusted operator input. Source
hashes bind their freshness; they do not establish that arbitrary participant-supplied
AST claims are true. The deployed participant boundary must never accept these records
from the requesting agent.
