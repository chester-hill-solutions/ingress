// Independent ground truth is frozen here, rather than inferred from producer output.
export const graphifyFiles = {
  'calc.mjs': 'export function increment(\n  value\n) {\n  return value + 1;\n}\n\nexport function sameName(value) {\n  return value + 10;\n}\n',
  'other.mjs': 'export function sameName(value) {\n  return value + 100;\n}\n',
  'barrel.mjs': 'export { increment as exportedIncrement } from "./calc.mjs";\n',
  'consumer.mjs': 'import { increment as renamed, sameName } from "./calc.mjs";\nimport { exportedIncrement as viaBarrel } from "./barrel.mjs";\nimport { sameName as otherName } from "./other.mjs";\n\nexport function useAlias(value) {\n  return renamed(value);\n}\n\nexport function useBarrel(value) {\n  return viaBarrel(value);\n}\n\nexport function useFirst(value) {\n  return sameName(value);\n}\n\nexport function useOther(value) {\n  return otherName(value);\n}\n\nexport function shadow(renamed) {\n  return renamed(3);\n}\n\nexport function dynamic(target, key) {\n  return target[key](3);\n}\n',
  'methods.mjs': '// café: byte positions must count UTF-8 bytes.\nexport class First {\n  run(value) {\n    return value + 1;\n  }\n}\n\nexport class Second {\n  run(value) {\n    return value + 2;\n  }\n}\n\nexport const arrow = (value) => {\n  return value + 3;\n};\n',
  'reciprocal.mjs': 'export function ping(n) {\n  return n > 0 ? pong(n - 1) : 0;\n}\n\nexport function pong(n) {\n  return n > 0 ? ping(n - 1) : 0;\n}\n',
  'embedded.mjs': 'export const embedded = "function hidden() { return 1; }";\n',
};

export const spanOracles = [
  { path: 'calc.mjs', name: 'increment', startLine: 1, endLine: 5 },
  { path: 'methods.mjs', name: 'First', startLine: 2, endLine: 6 },
  { path: 'methods.mjs', name: 'run', startLine: 3, endLine: 5 },
  { path: 'methods.mjs', name: 'run', startLine: 9, endLine: 11 },
  { path: 'methods.mjs', name: 'arrow', startLine: 14, endLine: 16 },
];

export const callOracles = [
  { name: 'renamed import', from: ['consumer.mjs', 'useAlias()'], to: ['calc.mjs', 'increment()'] },
  { name: 're-exported import', from: ['consumer.mjs', 'useBarrel()'], to: ['calc.mjs', 'increment()'] },
  { name: 'duplicate name first module', from: ['consumer.mjs', 'useFirst()'], to: ['calc.mjs', 'sameName()'] },
  { name: 'duplicate name second module', from: ['consumer.mjs', 'useOther()'], to: ['other.mjs', 'sameName()'] },
  { name: 'reciprocal forward', from: ['reciprocal.mjs', 'ping()'], to: ['reciprocal.mjs', 'pong()'] },
  { name: 'reciprocal reverse', from: ['reciprocal.mjs', 'pong()'], to: ['reciprocal.mjs', 'ping()'] },
];

export const productCallOracles = [
  { name: 'commit verifies bytes', from: ['src/product/handlers/commit.mjs', 'commit()'], to: ['src/product/commit.mjs', 'verifyCommit()'] },
  { name: 'commit evaluates fence', from: ['src/product/handlers/commit.mjs', 'commit()'], to: ['src/product/commit.mjs', 'evaluateCommit()'] },
  { name: 'commit stores revisions', from: ['src/product/handlers/commit.mjs', 'commit()'], to: ['src/product/content-store.mjs', 'storeRevisions()'] },
  { name: 'merge retrieves exact base', from: ['src/product/handlers/commit.mjs', 'resolveStaleBases()'], to: ['src/product/content-store.mjs', 'readRevision()'] },
  { name: 'merge combines bytes', from: ['src/product/handlers/commit.mjs', 'resolveStaleBases()'], to: ['src/product/merge.mjs', 'mergeBytes()'] },
  { name: 'content retention', from: ['src/product/content-store.mjs', 'storeRevision()'], to: ['src/product/content.mjs', 'retain()'] },
  { name: 'class method dispatch', from: ['src/product/lease.mjs', '.checkout()'], to: ['src/product/lease.mjs', '.sweep()'] },
];

export const productSpanOracles = [
  { path: 'src/product/content-store.mjs', name: 'storeRevision', startLine: 42, endLine: 77 },
  { path: 'src/product/content-store.mjs', name: 'storeRevisions', startLine: 91, endLine: 132 },
  { path: 'src/product/content-store.mjs', name: 'readRevision', startLine: 141, endLine: 144 },
  { path: 'src/product/handlers/commit.mjs', name: 'resolveStaleBases', startLine: 55, endLine: 86 },
  { path: 'src/product/lease.mjs', name: 'checkout', startLine: 239, endLine: 319 },
];
