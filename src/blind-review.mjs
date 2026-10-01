import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readMissionFile, verifyMission } from './mission-verifier.mjs';
import { blindReviewHTML } from './blind-review-ui.mjs';

const scoreNames = ['usefulness', 'completeness', 'clarity', 'coherence', 'overall'];
const boundedText = (value, max) => typeof value === 'string' && Buffer.byteLength(value) <= max;
export async function saveBlindJSON(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export async function createBlindStudy(directory, assignments, fixtures, protocol) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const study = { version: 1, created: new Date().toISOString(), status: 'assigned', protocol, samples: [], ratings: {} };
  // Labels are unrelated to assignment order or model identity. Display is shuffled independently.
  for (const assignment of assignments) {
    const fixture = fixtures.find(value => value.id === assignment.fixtureID);
    study.samples.push({ label: 'Sample ' + randomUUID().slice(0, 8), assignmentID: assignment.id, missionID: fixture.id,
      title: fixture.title, domain: fixture.domain, directive: fixture.files['MISSION.md'] ?? fixture.goal, references: fixture.protectedPaths.filter(path => !['package.json','MISSION.md'].includes(path)).map(name => ({ name, text: fixture.files[name] })), directiveHash: assignment.directiveHash, status: 'pending', artifacts: [], identity: null });
  }
  for (let i = study.samples.length - 1; i > 0; i--) {
    const j = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % (i + 1);
    [study.samples[i], study.samples[j]] = [study.samples[j], study.samples[i]];
  }
  await saveBlindJSON(join(directory, 'review-private.json'), study);
  return study;
}
function neutral(text) {
  let redactions = 0;
  return { text: text.replace(/(?:opencode\/)?(?:gpt-5-nano|deepseek-v4-flash)|Ingress|stock-(?:solo|two|four|eight)|ingress-(?:two|four|eight|pair)(?:-[a-z-]+)?|builder-reviewer/gi, () => { redactions++; return '[authorship withheld]'; }), get redactions() { return redactions; } };
}
export async function freezeBlindSample(directory, study, result, fixture) {
  const sample = study.samples.find(value => value.assignmentID === result.id);
  if (!sample || sample.status !== 'pending') throw Error('invalid_blind_sample');
  const folder = sample.label.replace('Sample ', 'sample-');
  await mkdir(join(directory, folder), { recursive: true, mode: 0o700 });
  const artifacts = [];
  const captureAllowed = !!result.workspace && result.actors?.length > 0 && result.actors.every(actor => actor.processStopped === true);
  for (const path of fixture.editablePaths) {
    try {
      if (!captureAllowed) throw Error('native_stop_unconfirmed_or_workspace_absent');
      const original = await readMissionFile(result.workspace, path), display = neutral(original);
      const digest = createHash('sha256').update(original).digest('hex');
      const file = 'artifact-' + artifacts.length + '.txt';
      await writeFile(join(directory, folder, file), original, { mode: 0o600 });
      artifacts.push({ name: path, file, sha256: digest, text: display.text, redactions: display.redactions, kind: path.endsWith('.html') ? 'html' : 'text' });
    } catch { artifacts.push({ name: path, missing: true, text: 'This deliverable is missing or exceeds the review bounds.', kind: 'text' }); }
  }
  if (fixture.reviewInvocation && captureAllowed) {
    let output;
    await verifyMission(fixture, result.workspace, async ({ invoke, check }) => {
      await check('review_invocation', async () => { const request = fixture.reviewInvocation; output = await invoke(request.path, request.exportName, request.args); });
    });
    if (output !== undefined) {
      const raw = JSON.stringify(output, null, 2), display = neutral(raw);
      artifacts.unshift({ name: 'Demonstration output.json', text: display.text, sha256: createHash('sha256').update(raw).digest('hex'), redactions: display.redactions, kind: 'text' });
      if (boundedText(output?.html, 1048576)) { const html = neutral(output.html); artifacts.unshift({ name: 'Product preview.html', text: html.text, redactions: html.redactions, kind: 'html' }); }
    } else artifacts.unshift({ name: 'Demonstration output', text: 'The submitted demonstration could not produce a bounded JSON result. The submitted files remain available below.', kind: 'text' });
  }
  sample.artifacts = artifacts;
  sample.status = 'ready'; sample.folder = folder;
  const usage = result.actors?.reduce((sum, actor) => { for (const name of ['input', 'output', 'cost']) if (Number.isFinite(actor.usage?.[name])) sum[name] = (sum[name] ?? 0) + actor.usage[name]; return sum; }, { input: null, output: null, cost: null });
  sample.identity = { captureBasis: captureAllowed ? 'bounded_files_after_confirmed_native_stop' : 'unavailable_unconfirmed_stop_or_missing_workspace', models: [...new Set(result.actorModels?.map(value => value.providerID + '/' + value.id) ?? [])], configuration: result.configID,
    agents: result.actors?.length ?? 0, outcome: result.outcome, automated: result.verification, artifactCorrect: result.artifactCorrect === true,
    nativeCorrect: result.correct === true, validComparison: result.validComparison === true, elapsedMs: result.elapsedMs ?? null,
    workMs: result.workMs ?? null, usage, usageBasis: 'Reported closed native steps only; missing or interrupted usage is not a billing reconciliation.', complexity: result.complexity ?? null };
  await saveBlindJSON(join(directory, 'review-private.json'), study);
  return sample.label;
}
function publicSample(study, sample, detail = false) {
  const rating = study.ratings[sample.label];
  return { label: sample.label, title: sample.title, domain: sample.domain, directiveHash: sample.directiveHash, status: sample.status,
    rated: !!rating, revealed: !!rating?.revealed, ...(detail ? { directive: sample.directive, references: sample.references ?? [], artifacts: sample.artifacts.map(({ name, text, kind, missing, redactions, sha256 }) => ({ name, text, kind, missing, redactions, sha256 })), rating: rating ? { scores: rating.scores, notes: rating.notes, unevaluable: rating.unevaluable } : null } : {}),
    ...(rating?.revealed ? { identity: sample.identity } : {}) };
}
export function blindProjection(study) {
  return { version: 1, status: study.status, assigned: study.samples.length, ready: study.samples.filter(value => value.status === 'ready').length,
    rated: Object.keys(study.ratings).length, samples: study.samples.map(value => publicSample(study, value)) };
}
export async function startBlindReview({ directory, port = 0 }) {
  const privatePath = join(directory, 'review-private.json');
  const readStudy = async () => {
    const info = await lstat(privatePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 33554432) throw Error('blind_state_bounds');
    const value = JSON.parse(await readFile(privatePath, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.samples) || value.samples.length > 512) throw Error('invalid_blind_state');
    try { value.ratings = JSON.parse(await readFile(join(directory, 'ratings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; value.ratings = {}; }
    return value;
  };
  let mutation = Promise.resolve();
  const nonce = randomUUID();
  const server = createServer(async (request, response) => {
    const address = server.address(), origin = `http://127.0.0.1:${address.port}`;
    const send = (status, value, type = 'application/json') => { response.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }); response.end(type === 'application/json' ? JSON.stringify(value) : value); };
    try {
      if (request.headers.host !== `127.0.0.1:${address.port}` || request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'loopback_origin_required' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/') return send(200, blindReviewHTML(nonce), 'text/html');
      if (request.method === 'GET' && url.pathname === '/api/samples') return send(200, blindProjection(await readStudy()));
      if (request.method === 'GET' && url.pathname === '/api/sample') {
        const study = await readStudy(), sample = study.samples.find(value => value.label === url.searchParams.get('label'));
        return sample ? send(200, publicSample(study, sample, true)) : send(404, { error: 'sample_not_found' });
      }
      if (request.method !== 'POST' || !['/api/rate', '/api/reveal'].includes(url.pathname) || request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json')) return send(404, { error: 'route_not_found' });
      let size = 0, chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 8192) return send(413, { error: 'body_bounds' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Ratings use their own file: trial publication cannot overwrite a human's saved judgment.
      const operation = mutation.catch(() => {}).then(async () => {
        const study = await readStudy(), sample = study.samples.find(value => value.label === input.label);
        if (!sample || sample.status !== 'ready') return { code: 409, data: { error: 'sample_not_ready' } };
        let ratings = {}; try { ratings = JSON.parse(await readFile(join(directory, 'ratings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        study.ratings = ratings;
        const current = ratings[input.label];
        if (url.pathname === '/api/reveal') {
          if (!current) return { code: 409, data: { error: 'rate_before_reveal' } };
          current.revealed = true; current.revealedAt = new Date().toISOString();
        } else {
          if (current?.revealed) return { code: 409, data: { error: 'revealed_rating_frozen' } };
          if (typeof input.unevaluable !== 'boolean' || !boundedText(input.notes ?? '', 4000) || !input.unevaluable && (!input.scores || scoreNames.some(name => !Number.isInteger(input.scores[name]) || input.scores[name] < 1 || input.scores[name] > 5) || Object.keys(input.scores).some(name => !scoreNames.includes(name)))) return { code: 400, data: { error: 'invalid_rating' } };
          ratings[input.label] = { scores: input.unevaluable ? null : input.scores, unevaluable: input.unevaluable, notes: input.notes ?? '', savedAt: new Date().toISOString(), revealed: false };
        }
        await saveBlindJSON(join(directory, 'ratings.json'), ratings);
        return { code: 200, data: publicSample(study, sample, true) };
      });
      mutation = operation;
      const result = await operation; send(result.code, result.data);
    } catch { send(400, { error: 'invalid_request_or_state' }); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
}
