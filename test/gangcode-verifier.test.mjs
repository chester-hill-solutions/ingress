import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyCanadaCrossroads, verifyGangCode } from '../fixtures/gangcode-verifier.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crossroads-verifier-'));
  const expectedEvents = JSON.parse(await readFile(new URL('../fixtures/canadian-history.json', import.meta.url), 'utf8'));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/history.json'), JSON.stringify(expectedEvents));
  await writeFile(join(root, 'server.mjs'), 'export function createGameServer(){throw new Error("Unimplemented server");}');
  return { root, expectedEvents };
}

test('unimplemented seed fails independent behavior checks without exposing implementation prose', async () => {
  const { root, expectedEvents } = await fixture();
  try {
    await writeFile(join(root, 'engine.mjs'), 'export function createGame(){throw new Error("Sensitive internal text");}');
    const result = await verifyCanadaCrossroads(root, { expectedEvents });
    assert.equal(result.correct, false);
    assert.equal(result.checks.find(check => check.name === 'content-integrity').passed, true);
    assert.equal(result.checks.find(check => check.name === 'correct-score-streak').passed, false);
    assert.equal(result.checks.find(check => check.name === 'http-server-start').passed, false);
    assert.ok(result.checks.every(check => Object.keys(check).sort().join(',') === 'name,passed'));
    assert.ok(!JSON.stringify(result).includes('Sensitive'));
    assert.equal(verifyGangCode, verifyCanadaCrossroads);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('detects answer-key leakage, wrong scoring and accepted duplicate answers in a supplied buggy game', async () => {
  const { root, expectedEvents } = await fixture();
  try {
    // Deliberately incomplete stand-in, not a reference implementation. It has three
    // specific defects that the verifier must catch independently of server/UI work.
    await writeFile(join(root, 'engine.mjs'), `export function createGame({events}) {
      let era='early-contact', score=0, answered=[], index=0;
      const rows=()=>events.filter(e=>e.era===era).sort((a,b)=>a.year-b.year);
      const snapshot=()=>({phase:index>=rows().length?'complete':'playing',era,score,streak:answered.length,answered:structuredClone(answered),currentEvent:rows()[index]??null,feedback:null,progress:{answered:answered.length,total:rows().length},milestones:[],mapEvents:rows(),revision:index});
      return {snapshot,chooseEra(value){era=value;score=0;answered=[];index=0;},restart(){score=0;answered=[];index=0;},answer(eventID,optionID){score+=20;answered.push({eventID,optionID,correct:true});index++;},subscribe(){return ()=>{};}};
    }`);
    const result = await verifyCanadaCrossroads(root, { expectedEvents });
    assert.equal(result.correct, false);
    for (const name of ['public-no-answer-keys', 'correct-score-streak', 'reject-duplicate-answer']) {
      assert.equal(result.checks.find(check => check.name === name).passed, false, name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('immutable historical facts are checked while presentation coordinates may change', async () => {
  const { root, expectedEvents } = await fixture();
  try {
    await writeFile(join(root, 'engine.mjs'), 'export function createGame(){throw new Error("Unimplemented");}');
    const displayed = structuredClone(expectedEvents);
    displayed[0].title = 'Presentation title'; displayed[0].region = 'Illustrative region'; displayed[0].x = 1; displayed[0].y = 99;
    await writeFile(join(root, 'data/history.json'), JSON.stringify(displayed));
    assert.equal((await verifyCanadaCrossroads(root, { expectedEvents })).checks.find(check => check.name === 'content-integrity').passed, true);
    displayed[0].correctOptionID = 'made-up-answer';
    await writeFile(join(root, 'data/history.json'), JSON.stringify(displayed));
    assert.equal((await verifyCanadaCrossroads(root, { expectedEvents })).checks.find(check => check.name === 'content-integrity').passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded process deadline kills hanging application import', async () => {
  const { root, expectedEvents } = await fixture();
  try {
    await writeFile(join(root, 'engine.mjs'), 'setInterval(()=>{},1000); await new Promise(()=>{}); export function createGame(){}');
    const started = Date.now();
    const result = await verifyCanadaCrossroads(root, { expectedEvents, timeoutMs: 100 });
    assert.deepEqual(result, { correct: false, checks: [{ name: 'verifier-timeout', passed: false }] });
    assert.ok(Date.now() - started < 2_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects extra stdout and oversized output instead of trusting application text', async () => {
  const { root, expectedEvents } = await fixture();
  try {
    await writeFile(join(root, 'engine.mjs'), 'console.log("unexpected application text");export function createGame(){throw new Error("unimplemented");}');
    assert.deepEqual(await verifyCanadaCrossroads(root, { expectedEvents }), { correct: false, checks: [{ name: 'verifier-output-invalid', passed: false }] });
    await writeFile(join(root, 'engine.mjs'), 'process.stdout.write("x".repeat(70000));export function createGame(){throw new Error("unimplemented");}');
    assert.deepEqual(await verifyCanadaCrossroads(root, { expectedEvents }), { correct: false, checks: [{ name: 'verifier-output-bound', passed: false }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
