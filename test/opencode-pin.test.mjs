/**
 * The pin, the record, and the binary that is actually installed.
 *
 * Three things name one fact and they drifted apart silently: `src/process.mjs` pinned
 * `opencode v2.0.16`, the compatibility record said the same, and the installed binary had
 * been upgraded to `v2.0.32` on 2026-10-19. Nothing failed. Every native harness run — squads,
 * benchmarks, trials, the model-driven recovery mission — began refusing with "Requires OpenCode
 * v2.0.16", the unit suite stayed green, and the breakage was found only when a model run was
 * attempted six days later.
 *
 * So this asserts the three agree, and skips only when there is no binary to check, which is the
 * case in a clean checkout. Raising the pin then means raising it in one place, re-running
 * `scripts/opencode-plugin-smoke.mjs --native-local` against the new binary, and re-recording
 * the attempt — which is what the record is for, and what the failure message says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PIN } from '../src/process.mjs';

const run = promisify(execFile);

test('the pinned version, the compatibility record and the installed binary agree', async t => {
  const record = JSON.parse(await readFile(new URL('../docs/opencode-plugin-compatibility.json', import.meta.url), 'utf8'));

  // The record is what justifies the pin; a record citing a different version justifies nothing.
  assert.equal(PIN, `opencode v${record.installedVersion}`,
    `src/process.mjs pins ${PIN} and docs/opencode-plugin-compatibility.json qualifies ${record.installedVersion}`);
  assert.match(record.pinnedSourceCommit ?? '', /^[0-9a-f]{40}$/,
    'the record must name the source commit the pin refers to');

  const binary = join(homedir(), '.opencode', 'bin', 'opencode');
  try {
    await access(binary);
  } catch {
    t.skip('no installed OpenCode binary in this checkout');
    return;
  }

  const { stdout } = await run(binary, ['--version'], { timeout: 15_000 });
  const installed = stdout.trim();
  assert.equal(installed, PIN,
    `the installed OpenCode is ${installed} and the harness is pinned to ${PIN}: run ` +
    '`node scripts/opencode-plugin-smoke.mjs --native-local` against the new binary, append the ' +
    'attempt to docs/opencode-plugin-compatibility.json, and raise PIN to match');
});
