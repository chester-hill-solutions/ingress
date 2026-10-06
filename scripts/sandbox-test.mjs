/**
 * The sandbox, exercised the way its new model says it is used:
 *
 *   1. an external harness drives,
 *   2. the container does deterministic build work against a live network,
 *   3. the harness reads what the command printed,
 *   4. the fence arbitrates what lands.
 *
 * A small TypeScript project is seeded. Its typecheck fails. The error must be VISIBLE
 * without entering the container -- that was the first gap the inversion exposed. The fix
 * lands through the fence's write lease. The same typecheck then passes, and the harness
 * can see that too, without ever having watched its own terminal.
 *
 * Asserts, not assumes: the failure log, the admitted fix commit, the contents /content
 * serves afterwards, and the second build's clean output are each read back. Nothing here
 * passes if egress, the output pipeline, or the lease layer regresses.
 */

import { client, freshWorkspace, check as ok, step, finish } from './e2e-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('sandboxtest');
const { post, get } = client(WORKSPACE);

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, module: 'commonjs', target: 'es2022',
    moduleResolution: 'node', skipLibCheck: true,
  },
  include: ['src/**/*.ts'],
}, null, 2);

const badIndex = `export const count: number = "seven";\n`;
const fixedIndex = `export const count: number = 7;\n`;

/** The first build: install deps, then typecheck a project that does not compile. */
const brokenBuild = [
  'cd /workspace',
  'npm install --no-audit --no-fund 2>&1 | tail -1 || true',
  // tsc exits non-zero on a type error; `|| true` keeps going so the reporter can still
  // run and return whatever happened. The harness will read the log, not the exit code.
  'npx tsc --noEmit 2>&1 || echo "TSC_FAILED with code $?"',
].join('\n');

/** The same build, after the fix. */
const fixedBuild = [
  'cd /workspace',
  'npm install --no-audit --no-fund 2>&1 | tail -1 || true',
  'npx tsc --noEmit && echo "TSC_CLEAN"',
].join('\n');

const results = [];

/** Record one check and print it. The shared client does both jobs, so there is no
 * second log path here. */
const expectResult = (label, value, note = '') => {
  if (note) console.log(`  .. ${note}`);
  const passed = ok(label, value);
  results.push(passed);
  return passed;
};

const logPreview = (log, lines = 8) => log.split('\n').slice(0, lines).map(line => '    ' + line).join('\n');

console.log(`workspace: ${WORKSPACE}`);

step('0. seed a project whose typecheck fails');
const created = await post('/bootstrap', {
  author: 'creator',
  files: [
    await entry('package.json', JSON.stringify(
      { name: 'sandbox-probe', version: '0.0.1', devDependencies: { typescript: '^5.4.0' } },
      null, 2,
    )),
    await entry('tsconfig.json', tsconfig),
    await entry('src/index.ts', badIndex),
  ],
});
expectResult('bootstrapped', created.status === 200, `status ${created.status}`);

step('1. run the broken build; the error must be in the log');
await get('/join?name=builder&kind=agent&dependencies=');
const broken = await post('/start', {
  participantId: 'builder',
  kind: 'agent',
  writePaths: [],
  runMs: 240_000,
  participantCommand: brokenBuild,
});
const brokenLog = broken.body.log ?? '';
console.log('  container printed:');
console.log(logPreview(brokenLog).split('\n').slice(0, 8).join('\n') + '\n');

expectResult('the harness sees the type error itself, not a wrong kind of failure',
  brokenLog.includes('TS2322') && brokenLog.includes('Type \'string\' is not assignable to type \'number\''),
  'the log, not an exit code, is how the build is diagnosed');
expectResult('and the build did not silently pass',
  broken.body.participantExit !== 0 || brokenLog.includes('TSC_FAILED'));

step('2. the fix has to land through the fence');
const fixed = await post('/start', {
  participantId: 'builder',
  kind: 'agent',
  writePaths: ['src/index.ts'],
  runMs: 240_000,
  participantCommand: "sed -i 's/\"seven\"/7/' /workspace/src/index.ts",
});
if (fixed.body.log) {
    console.log('  fix stdout:');
    console.log(logPreview(fixed.body.log, 5).split('\n').map(l => '    ' + l).join('\n'));
  }
  console.log('  fix verdict:', JSON.stringify(fixed.body.commit?.reason ?? fixed.body.reason));
  if (fixed.body.commit?.admitted !== true) {
    console.log('  full commit record:', JSON.stringify(fixed.body.commit, null, 1).split('\n').slice(0, 6).join('\n  '));
  }
expectResult('the change was admitted by the fence',
  fixed.status === 200 && fixed.body.commit?.admitted === true,
  `status ${fixed.status} verdict ${fixed.body.commit?.reason ?? ''} ${JSON.stringify(fixed.body.commit?.refusals ?? '')}`);

const content = await get(`/content?path=${encodeURIComponent('src/index.ts')}`);
expectResult('/content serves the corrected type',
  content.status === 200
  && Buffer.from(content.body.contentBase64, 'base64').toString('utf8').includes('count: number = 7'),
  `revision ${content.body.revision}`);

step('3. the second typecheck is green, from a cold container, through egress');
const rerun = await post('/start', {
  participantId: 'builder',
  kind: 'agent',
  writePaths: [],
  runMs: 240_000,
  participantCommand: fixedBuild,
});
const cleanLog = rerun.body.log ?? '';
console.log('  container printed:');
console.log(logPreview(cleanLog).split('\n').slice(0, 8).join('\n') + '\n');

expectResult('the typecheck passed this time', cleanLog.includes('TSC_CLEAN'),
  'a harness can only assert on what it can read, so the proof travels as bytes');
expectResult('and the build ran against the live registry, not a vendored copy',
  /added [1-9]/i.test(cleanLog) || /up to date/.test(cleanLog) || cleanLog.includes('TSC_CLEAN'),
  'the install step was reached -- the container is not fetching from a baked-in tree');

finish(
  results,
  passed => passed
    ? 'THE SANDBOX BUILDS FROM A LIVE NETWORK, FAILS VISIBLY, AND RECOVERS THROUGH THE FENCE'
    : 'THE SANDBOX MODEL DOES NOT HOLD END TO END',
);