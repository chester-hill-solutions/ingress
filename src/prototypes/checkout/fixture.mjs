// Frozen, hand-authored fixture: ground truth stays outside the arbiter's graph.
export const files = {
  'pricing.mjs': 'export function discountSubtotal(subtotal, rate) {\n  return subtotal * (1 - rate);\n}\n\nexport function shippingFee(weight) {\n  return weight > 10 ? 20 : 5;\n}\n',
  'invoice.mjs': 'import { discountSubtotal } from "./pricing.mjs";\n\nexport function createInvoice(subtotal, rate) {\n  return { totalPaid: discountSubtotal(subtotal, rate) };\n}\n',
  'refund.mjs': 'export function refundForOrder(order, fraction) {\n  return order.totalPaid * fraction;\n}\n',
  'audit.mjs': 'import { createInvoice } from "./invoice.mjs";\n\nexport function auditTotal(subtotal, rate) {\n  return Math.round(createInvoice(subtotal, rate).totalPaid * 100);\n}\n',
  'tutorial.mjs': '// Independent documentation example; never used by checkout, invoices or refunds.\nexport function exampleDiscount(subtotal, rate) {\n  return subtotal * (1 - rate);\n}\n',
  'theme.mjs': 'export function themeName(dark) {\n  return dark ? "night" : "day";\n}\n',
  'contract.md': 'Invoices persist the discounted amount in the totalPaid field of an order.\nRefunds consume that stored totalPaid value; changing its units or meaning affects refunds.\n',
};

export const blocks = [
  { id: 'discount', path: 'pricing.mjs', startLine: 1, endLine: 3 },
  { id: 'shipping', path: 'pricing.mjs', startLine: 5, endLine: 7 },
  { id: 'invoice', path: 'invoice.mjs', startLine: 1, endLine: 5 },
  { id: 'refund', path: 'refund.mjs', startLine: 1, endLine: 3 },
  { id: 'audit', path: 'audit.mjs', startLine: 1, endLine: 5 },
  { id: 'tutorial', path: 'tutorial.mjs', startLine: 1, endLine: 4 },
  { id: 'theme', path: 'theme.mjs', startLine: 1, endLine: 3 },
  { id: 'contract', path: 'contract.md', startLine: 1, endLine: 2 },
];

export const edges = [
  { from: 'invoice', to: 'discount', evidence: 'invoice.mjs imports and calls discountSubtotal' },
  { from: 'audit', to: 'invoice', evidence: 'audit.mjs imports and calls createInvoice' },
];

export const fixture = { files, blocks, edges };
export const requestFor = (participantId, blockId, intent = `Modify ${blockId}`) => ({ participantId, writes: [{ blockId }], intent });

// Both orderings are retained. Only these synthetic cases have known truth.
export const comparisonCases = [
  { id: 'overlap', a: 'discount', b: 'discount', conflict: true },
  { id: 'disjoint-same-file', a: 'discount', b: 'shipping', conflict: false },
  { id: 'provider-first', a: 'discount', b: 'invoice', conflict: true },
  { id: 'consumer-first', a: 'invoice', b: 'discount', conflict: true },
  { id: 'transitive', a: 'discount', b: 'audit', conflict: true },
  { id: 'transitive-reverse', a: 'audit', b: 'discount', conflict: true },
  { id: 'shared-read-dependency', a: 'left', b: 'right', conflict: false, siblings: true },
  { id: 'persisted-contract', a: 'invoice', b: 'refund', conflict: true,
    aIntent: 'Change totalPaid from discounted currency units to integer cents in persisted orders',
    bIntent: 'Modify refunds calculated from the persisted order totalPaid in currency units', hidden: true },
  { id: 'persisted-contract-reverse', a: 'refund', b: 'invoice', conflict: true,
    aIntent: 'Change how refunds interpret persisted order totalPaid amounts',
    bIntent: 'Change the units of discounted totalPaid saved on invoices', hidden: true },
  { id: 'similar-independent-code', a: 'discount', b: 'tutorial', conflict: false,
    aIntent: 'Modify production discount calculations', bIntent: 'Modify the independent tutorial discount example' },
  { id: 'unrelated', a: 'shipping', b: 'theme', conflict: false },
];

export function fixtureForCase(entry) {
  if (!entry.siblings) return fixture;
  return { ...fixture,
    files: { ...files, 'left.mjs': 'left\n', 'right.mjs': 'right\n', 'utility.mjs': 'shared\n' },
    blocks: [...blocks, ...['left', 'right', 'utility'].map(id => ({ id, path: `${id}.mjs`, startLine: 1, endLine: 1 }))],
    edges: [...edges, ...['left', 'right'].map(from => ({ from, to: 'utility', evidence: `${from} reads the shared immutable utility` }))] };
}
