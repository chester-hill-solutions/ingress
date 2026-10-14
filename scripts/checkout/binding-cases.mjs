// Independent adversarial binding oracles; never inputs to the producer.
const provider = 'export function target() { return 1; }\n';
const importing = "import { target as alias } from './provider.mjs';\n";
export const bindingCases = [
  { id: 'math-min-intrinsic', files: { 'consumer.mjs': 'export function consumer(x) { return Math.min(x, 3); }\n' }, known: 'consumer.mjs#consumer' },
  { id: 'math-min-shadow', files: { 'consumer.mjs': 'export function consumer(Math) { return Math.min(1, 3); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'integer-intrinsic', files: { 'consumer.mjs': 'export function consumer(x) { return Number.isInteger(x); }\n' }, known: 'consumer.mjs#consumer' },
  { id: 'integer-shadow', files: { 'consumer.mjs': 'export function consumer(Number) { return Number.isInteger(1); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'inline-named-helper', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer() { function helper() { return alias(); } return helper(); }\n' }, call: ['consumer.mjs#consumer', 'provider.mjs#target'], known: 'consumer.mjs#consumer' },
  { id: 'inline-helper-reassignment', files: { 'consumer.mjs': 'export function consumer(callback) { function helper() { return 1; } helper = callback; return helper(); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'inline-helper-shadow', files: { 'consumer.mjs': 'export function consumer() { function helper() { return 1; } const nested = (helper) => helper(); return helper(); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'single-arrow-parameter', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer() { const cb = item => alias(item); return cb; }\n' }, call: ['consumer.mjs#consumer', 'provider.mjs#target'], known: 'consumer.mjs#consumer' },
  { id: 'single-arrow-import-shadow', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer() { const cb = alias => alias(); return cb; }\n' }, forbidden: ['consumer.mjs#consumer', 'provider.mjs#target'], unknown: 'consumer.mjs#consumer' },
  { id: 'renamed-reexport', files: { 'provider.mjs': provider, 'barrel.mjs': "export { target as renamed } from './provider.mjs';\n",
    'consumer.mjs': "import { renamed as alias } from './barrel.mjs';\nexport function consumer() { return alias(); }\n" },
    call: ['consumer.mjs#consumer', 'provider.mjs#target'] },
  { id: 'parameter-shadow', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer(alias) { return alias(); }\n' }, forbidden: ['consumer.mjs#consumer', 'provider.mjs#target'], unknown: 'consumer.mjs#consumer' },
  { id: 'block-shadow', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer(callback) { { const alias = callback; return alias(); } }\n' }, forbidden: ['consumer.mjs#consumer', 'provider.mjs#target'], unknown: 'consumer.mjs#consumer' },
  { id: 'catch-shadow', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer() { try { throw 0; } catch (alias) { return alias(); } }\n' }, forbidden: ['consumer.mjs#consumer', 'provider.mjs#target'], unknown: 'consumer.mjs#consumer' },
  { id: 'arrow-shadow', files: { 'provider.mjs': provider, 'consumer.mjs': importing + 'export function consumer() { const local = (alias) => alias(); return local; }\n' }, forbidden: ['consumer.mjs#consumer', 'provider.mjs#target'], unknown: 'consumer.mjs#consumer' },
  { id: 'builtin-shadow', files: { 'consumer.mjs': 'export function consumer(Math) { return Math.round(1); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'shared-property-mutation', files: { 'provider.mjs': 'export const settings = { enabled: true };\n', 'consumer.mjs': "import { settings } from './provider.mjs';\nexport function consumer() { settings.enabled = false; }\n" }, unknown: 'consumer.mjs#consumer' },
  { id: 'map-method-replacement', files: { 'consumer.mjs': 'export function consumer(callback) { const map = new Map(); map.get = callback; return map.get(1); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'unbound-reference', files: { 'consumer.mjs': 'export function consumer() { return hiddenRegistry.value; }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'irrelevant-typeof', files: { 'consumer.mjs': "export function consumer(value) { if (typeof value === 'string') throw 0; return value.trim(); }\n" }, unknown: 'consumer.mjs#consumer' },
  { id: 'computed-dispatch', files: { 'consumer.mjs': 'export function consumer(target, key) { return target[key](); }\n' }, unknown: 'consumer.mjs#consumer' },
  { id: 'eval-string', files: { 'consumer.mjs': "export function consumer() { return eval('hidden()'); }\n" }, unknown: 'consumer.mjs#consumer' },
  { id: 'malformed-body', files: { 'consumer.mjs': 'export function consumer() { return (1; }\n' }, refusal: 'parse_error' },
  { id: 'runtime-invalid-duplicate', files: { 'consumer.mjs': 'export function consumer() { let x; let x; return 1; }\n' }, refusal: 'parse_error' },
  { id: 'reexport-cycle', files: { 'one.mjs': "export { target } from './two.mjs';\n", 'two.mjs': "export { target } from './one.mjs';\n",
    'consumer.mjs': "import { target } from './one.mjs';\nexport function consumer() { return target(); }\n" }, unknown: 'consumer.mjs#consumer' },
];

export function checkBindingCase(scenario, index) {
  const edge = pair => index.edges.some(item => item.from === pair[0] && item.to === pair[1]);
  return (!scenario.call || edge(scenario.call)) && (!scenario.forbidden || !edge(scenario.forbidden))
    && (!scenario.known || !index.unknown.some(item => item.blockId === scenario.known))
    && (!scenario.unknown || index.unknown.some(item => item.blockId === scenario.unknown));
}
