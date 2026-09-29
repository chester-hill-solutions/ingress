import test from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../src/dashboard.mjs';

test('loopback view refuses cross-origin/mutating and unknown requests', async () => {
  const server = await startDashboard(() => ({ phase: 'test', state: null, events: [] }));
  try {
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(server.url, { headers: { origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(server.url + 'fixture/producer.mjs')).status, 404);
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /textContent/);
  } finally { await server.close(); }
});

test('SSE first snapshot and later push deliver changed state without polling', async () => {
  let state = { phase: 'first', state: null, events: [] };
  const server = await startDashboard(() => state);
  const controller = new AbortController();
  let reader;
  try {
    const response = await fetch(server.url + 'events', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
    reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"phase":"first"/);
    state = { ...state, phase: 'second' }; server.push();
    const second = await reader.read();
    assert.match(new TextDecoder().decode(second.value), /"phase":"second"/);
  } finally { controller.abort(); await reader?.cancel().catch(() => {}); await server.close(); }
});
