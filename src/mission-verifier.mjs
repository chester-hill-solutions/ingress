import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const missionBounds = Object.freeze({ fileBytes: 1048576, totalBytes: 16777216, files: 128, invocationBytes: 1048576, invocations: 16, invocationMs: 3500, evaluatorMs: 30000 });

/**
 * Submission isolation needs the Node 26 permission model: it is what denies
 * writes, private reads, child processes and network without trusting the
 * submission. Without it there is no isolation to test, so a refusal here is a
 * missing harness capability, never evidence about the submission.
 */
export const missionIsolationRefusal = 'mission_invocation_requires_node_26_network_permissions';
export function missionIsolationAvailable() { return Number(process.versions.node.split('.')[0]) >= 26; }
export function missionPath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('invalid_mission_path');
  return path;
}
export async function readMissionFile(root, path) {
  missionPath(path);
  const canonical = await realpath(root), target = join(canonical, path);
  let cursor = canonical;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw Error('mission_symlink');
  }
  const info = await lstat(target), actual = await realpath(target), rel = relative(canonical, actual);
  if (!info.isFile() || info.size > missionBounds.fileBytes || !rel || rel.startsWith('../') || rel === '..') throw Error('mission_file_bounds');
  const bytes = await readFile(target);
  if (bytes.length > missionBounds.fileBytes) throw Error('mission_file_bounds');
  return bytes.toString('utf8');
}

// Submission code receives inputs only. Assertions and expected values stay in the parent.
async function invokeSubmission(root, path, exportName, args, timeoutMs) {
  if (!missionIsolationAvailable()) throw Error(missionIsolationRefusal);
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,100}$/.test(exportName) || !Array.isArray(args)) throw Error('invalid_mission_invocation');
  const payload = JSON.stringify({ url: pathToFileURL(join(root, path)).href, exportName, args });
  if (Buffer.byteLength(payload) > missionBounds.invocationBytes) throw Error('mission_invocation_bounds');
  const nonce = randomUUID();
  const script = `let data=''; for await(const part of process.stdin)data+=part; const input=JSON.parse(data); const mod=await import(input.url); if(typeof mod[input.exportName]!=='function')throw Error('missing_export'); const value=await mod[input.exportName](...input.args); process.stdout.write(${JSON.stringify(nonce)}+JSON.stringify(value));`;
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--permission', '--allow-fs-read=' + root, '--max-old-space-size=96', '--input-type=module', '-e', script], { cwd: root, env: { LANG: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = [], size = 0, diagnosticSize = 0, failed = false, timer;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', value => { size += value.length; if (size > missionBounds.invocationBytes) fail(); else output.push(value); });
    child.stderr.on('data', value => { diagnosticSize += value.length; if (diagnosticSize > 65536) fail(); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Error('mission_invocation_failed')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) return reject(Error('mission_invocation_failed'));
      const text = Buffer.concat(output).toString('utf8');
      if (!text.startsWith(nonce)) return reject(Error('mission_invocation_response_invalid'));
      try { accept(JSON.parse(text.slice(nonce.length))); } catch { reject(Error('mission_invocation_response_invalid')); }
    });
    child.stdin.end(payload);
  });
}

export async function verifyMission(fixture, root, evaluate) {
  const checks = [], instructionChecks = [], started = performance.now();
  const names = new Set(), declared = new Set(Object.keys(fixture.files));
  let canonical, remainingCalls = missionBounds.invocations, scopeValid = true, total = 0;
  try {
    canonical = await realpath(root);
    if (declared.size > missionBounds.files) throw Error('mission_scope_bounds');
    for (const path of declared) total += Buffer.byteLength(await readMissionFile(canonical, path));
    if (total > missionBounds.totalBytes) throw Error('mission_scope_bounds');
  } catch { scopeValid = false; }
  const protectedCheck = async path => {
    let passed = false;
    try { passed = await readMissionFile(canonical, path) === fixture.files[path]; } catch {}
    return { name: 'protected:' + path, passed };
  };
  for (const path of fixture.protectedPaths) instructionChecks.push(await protectedCheck(path));
  instructionChecks.push({ name: 'confined_declared_files', passed: scopeValid });
  const readText = async path => {
    if (!declared.has(path)) throw Error('undeclared_mission_file');
    return readMissionFile(canonical, path);
  };
  const check = async (name, assertion) => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(name) || names.has(name)) throw Error('invalid_mission_check');
    names.add(name); let passed = false;
    try { await assertion(); passed = true; } catch {}
    checks.push({ name, passed });
  };
  const invoke = async (path, exportName, args) => {
    const remaining = missionBounds.evaluatorMs - (performance.now() - started);
    if (--remainingCalls < 0 || remaining < 1 || !declared.has(path)) throw Error('mission_invocation_bounds');
    await readText(path);
    return invokeSubmission(canonical, path, exportName, args, Math.min(missionBounds.invocationMs, remaining));
  };
  let isolationRefused = false;
  if (scopeValid && instructionChecks.every(value => value.passed)) {
    try { await evaluate({ readText, readJSON: async path => JSON.parse(await readText(path)), invoke, check }); }
    catch (error) {
      // A missing isolation capability is a harness fact. Recorded as its own
      // check rather than a generic evaluator failure, because otherwise a
      // perfect submission on an unsupported runtime is indistinguishable from
      // a wrong one, and the evidence would blame the model for the host.
      isolationRefused = error?.message === missionIsolationRefusal;
      checks.push({ name: isolationRefused ? 'evaluator_refused_isolation_unavailable' : 'evaluator_completed', passed: false });
    }
  }
  for (const criterion of fixture.criteria) if (!checks.some(value => value.name === criterion.id)) checks.push({ name: criterion.id, passed: false });
  for (const item of instructionChecks.filter(value => value.name.startsWith('protected:'))) item.passed &&= (await protectedCheck(item.name.slice(10))).passed;
  return { correct: !isolationRefused && checks.length > 0 && checks.every(value => value.passed) && instructionChecks.every(value => value.passed), isolationRefused, checks, instructionChecks };
}
