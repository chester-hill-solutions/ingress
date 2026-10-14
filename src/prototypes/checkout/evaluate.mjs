import { CheckoutArbiter } from './arbiter.mjs';
import { comparisonCases, fixtureForCase, requestFor } from './fixture.mjs';
import { discoverCandidates, indexCatalog } from './impact.mjs';

const totals = cases => ({ assigned: cases.length, completed: cases.filter(row => !row.error).length,
  missedInterference: cases.filter(row => row.expectedConflict && row.granted === true).length,
  unnecessaryBlocking: cases.filter(row => !row.expectedConflict && row.granted === false).length,
  errors: cases.filter(row => row.error).length });

export async function evaluateCheckouts({ client, topK = 3, minimumScore = 0.2 } = {}) {
  const indexes = new Map();
  const report = { fixture: 'checkout-v1', synthetic: true, usefulBenefitQualified: false,
    groundTruth: 'hand-authored cases, including two persisted-contract relationships omitted from the declared graph',
    dependencyCoverage: 'declared fixture edges only; completeness unknown',
    baseline: { policy: 'declared dependencies', cases: [] },
    embeddings: { policy: 'protect unconfirmed top-K candidates (experimental conservative policy)',
      status: client ? 'pending' : 'not_run', topK, minimumScore, cases: [] } };
  if (client) {
    try { report.embeddings.model = await client.metadata(); report.embeddings.status = 'completed'; }
    catch (error) { report.embeddings.status = 'unavailable'; report.embeddings.error = error.message; }
  }
  for (const entry of comparisonCases) {
    const config = fixtureForCase(entry);
    const a = requestFor('a', entry.a, entry.aIntent), b = requestFor('b', entry.b, entry.bIntent);
    const base = new CheckoutArbiter(config);
    const first = base.checkout(a, 0), second = base.checkout(b, 0);
    report.baseline.cases.push({ id: entry.id, expectedConflict: entry.conflict, hiddenRelationship: !!entry.hidden,
      firstGranted: first.granted, granted: second.granted, reason: second.reason ?? null });
    if (!client) continue;
    if (report.embeddings.status === 'unavailable') {
      report.embeddings.cases.push({ id: entry.id, expectedConflict: entry.conflict, error: report.embeddings.error });
      continue;
    }
    try {
      const arbiter = new CheckoutArbiter(config);
      const key = JSON.stringify(config);
      if (!indexes.has(key)) indexes.set(key, await indexCatalog(arbiter.catalog, client.embed));
      const index = indexes.get(key);
      const aCandidates = await discoverCandidates(index, a, client.embed, { topK, minimumScore });
      const bCandidates = await discoverCandidates(index, b, client.embed, { topK, minimumScore });
      const aGrant = arbiter.checkout({ ...a, candidates: aCandidates, candidatePolicy: 'protect' }, 0);
      const bGrant = arbiter.checkout({ ...b, candidates: bCandidates, candidatePolicy: 'protect' }, 0);
      report.embeddings.cases.push({ id: entry.id, expectedConflict: entry.conflict, hiddenRelationship: !!entry.hidden,
        firstGranted: aGrant.granted, granted: bGrant.granted, reason: bGrant.reason ?? null,
        aCandidates, bCandidates });
    } catch (error) { report.embeddings.cases.push({ id: entry.id, expectedConflict: entry.conflict, error: error.message }); }
  }
  report.baseline.totals = totals(report.baseline.cases);
  report.embeddings.totals = client ? totals(report.embeddings.cases) : null;
  if (client && report.embeddings.totals.errors && report.embeddings.status !== 'unavailable') report.embeddings.status = 'incomplete';
  return report;
}
