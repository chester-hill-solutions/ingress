import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceState } from './workspace-state.mjs';
import { observeFiles } from './file-observer.mjs';
import { DecisionLane } from './decisions.mjs';
import { seedFixture, verifyFixture } from '../fixtures/money.mjs';

/** Deterministic actors validate plumbing; they are never model-benefit evidence. */
export async function runApparatus(onUpdate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-collaboration-apparatus-'));
  const fixture = await seedFixture(root), state = new WorkspaceState({ epoch: randomUUID() });
  const events = [], lane = new DecisionLane();
  const publish = phase => onUpdate({ phase, state: state.snapshot(), events });
  const observer = await observeFiles({ root, paths: fixture.paths, epoch: state.epoch, intervalMs: 100,
    onObservation(event) { state.ingest(event); events.push({ source: event.source, type: event.type, path: event.data.path }); } });
  try {
    for (const id of ['producer', 'consumer']) {
      state.register({ id, task: id === 'producer' ? fixture.producerTask : fixture.consumerTask, sessionID: 'simulated-' + id, generation: 1, dependencies: id === 'consumer' ? fixture.dependencies : [] });
      state.setIntention(id, 'Deterministic actor: ' + id + ' fixture task');
      events.push({ actor: id, ...state.joinFile(id, 'producer.mjs') });
    }
    const basis = state.files.get('producer.mjs');
    state.ingest({ id: randomUUID(), epoch: state.epoch, source: 'native', sourceSeq: 1, participantID: 'consumer', sessionID: 'simulated-consumer', generation: 1, type: 'activity.observed', data: { path: 'producer.mjs', kind: 'read', hash: basis.hash, revision: basis.revision, verified: true } });
    publish('Deterministic apparatus: consumer has a known old basis');
    await writeFile(join(root, 'producer.mjs'), "export const priceUnit='cents'; export function priceOrders(orders){return orders.map(o=>({sku:o.sku,quantity:o.quantity,unitPrice:Math.round(o.unitPriceDollars*100)}));}\n");
    await observer.reconcile();
    const receipt = await lane.evaluate(state.decisionCut('consumer'), { currentCut: () => state.decisionCut('consumer') });
    events.push({ actor: 'consumer', type: 'shadow.decision', status: receipt.decision?.action });
    const incomplete = await verifyFixture(root);
    publish('Deterministic apparatus: dependency change observed; refresh recommended');
    await writeFile(join(root, 'consumer.mjs'), "import {priceOrders,priceUnit} from './producer.mjs';\nconst lines=o=>priceOrders(o).map(r=>({...r,cents:Math.round(r.unitPrice*(priceUnit==='cents'?1:100))}));\nexport function invoiceLines(o){return lines(o).map(r=>({sku:r.sku,quantity:r.quantity,lineTotalDollars:r.cents*r.quantity/100}));}\nexport function summarizeOrders(o){const r=lines(o);return {orderCount:r.length,unitCount:r.reduce((n,r)=>n+r.quantity,0),totalDollars:r.reduce((n,r)=>n+r.cents*r.quantity,0)/100};}\nexport function formatInvoice(o){const s=summarizeOrders(o);return '$'+s.totalDollars.toFixed(2)+' for '+s.unitCount+' units across '+s.orderCount+' lines';}\n");
    await observer.reconcile();
    const verification = await verifyFixture(root);
    publish('Deterministic apparatus complete; no real-agent benefit claim');
    return { kind: 'deterministic-apparatus', condition: 'apparatus', verification, incompleteDetected: !incomplete.correct,
      shadow: [receipt], state: state.snapshot(), events, limits: { simulatedActors: true, productBenefitEstablished: false, jevEvaluated: false } };
  } finally { observer.close(); lane.close(); }
}
