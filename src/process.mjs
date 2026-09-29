import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PIN = 'opencode v2.0.16';
const OUTPUT_LIMIT = 65536;
const CATALOG_LIMIT = 8 * 1024 * 1024;
const AMBIENT_KEYS = new Set(['PATH', 'LANG', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']);

export function scopedEnvironment(stateDir, apiKey, ambient = process.env) {
  const env = Object.fromEntries(Object.entries(ambient).filter(([name]) => AMBIENT_KEYS.has(name.toUpperCase()) || /^LC_[A-Z_]+$/.test(name)));
  const home = join(resolve(stateDir), 'opencode', 'home');
  Object.assign(env, { HOME: home, XDG_DATA_HOME: join(home, '.local/share'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state') });
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !apiKey || /[\r\n\0]/.test(apiKey)) throw new Error('Invalid explicit provider credential');
    env.OPENCODE_API_KEY = apiKey;
  }
  return env;
}

export async function stopProcess(child, { graceMs = 1000, killMs = 5000 } = {}) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  if (await deadline(exited, graceMs)) return;
  child.kill('SIGKILL');
  if (!await deadline(exited, killMs)) throw Object.assign(new Error('OpenCode process stop unconfirmed'), { stopUnconfirmed: true });
}

async function deadline(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), ms); })]); }
  finally { clearTimeout(timer); }
}

async function probeVersion(binary, directory, env, signal) {
  const child = spawn(binary, ['--version'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0, output = '';
  try {
    await new Promise((accept, reject) => {
      let done = false;
      const finish = error => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); error ? reject(error) : accept(); };
      const aborted = () => finish(new Error('OpenCode version verification cancelled'));
      const timer = setTimeout(() => finish(new Error('OpenCode version verification timeout')), 15000);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) finish(new Error('OpenCode version output exceeds limit')); else output += chunk.toString(); });
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) finish(new Error('OpenCode version output exceeds limit')); });
      child.once('error', () => finish(new Error('OpenCode executable could not start')));
      child.once('exit', code => finish(code === 0 && output.trim() === PIN ? undefined : new Error('Requires OpenCode v2.0.16')));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  } finally { await stopProcess(child); }
}

export async function startOpenCode({ binary, stateDir, directory, apiKey, baseURL, modelCatalogPath, signal }) {
  signal?.throwIfAborted();
  const env = scopedEnvironment(stateDir, apiKey);
  await Promise.all(['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(name => mkdir(env[name], { recursive: true, mode: 0o700 })));
  if (modelCatalogPath) {
    const file = await open(modelCatalogPath, 'r');
    try {
      if ((await file.stat()).size > CATALOG_LIMIT) throw new Error('Model catalog exceeds startup limit');
      // Bound allocation even if the source grows between stat and read.
      const bytes = Buffer.alloc(CATALOG_LIMIT + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > CATALOG_LIMIT) throw new Error('Model catalog exceeds startup limit');
      const content = bytes.subarray(0, size);
      JSON.parse(content.toString('utf8'));
      const destination = join(env.XDG_CACHE_HOME, 'opencode');
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await writeFile(join(destination, 'models.json'), content, { mode: 0o600, flag: 'wx' });
    } finally { await file.close(); }
  }
  if (baseURL !== undefined) {
    const url = new URL(baseURL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Provider baseURL must be HTTPS or literal loopback');
    // Exact v2 schema: providers.<id>.settings; no credentials persisted here.
    await writeFile(join(env.XDG_CONFIG_HOME, 'opencode.json'), JSON.stringify({ providers: { opencode: { settings: { baseURL: url.href } } } }), { mode: 0o600, flag: 'wx' });
  }
  await probeVersion(binary, directory, env, signal);
  signal?.throwIfAborted();
  // Use the installed v2.0.16 binary's verified help surface; it has no --pure flag.
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let closePromise;
  const close = () => closePromise ??= stopProcess(child);
  try {
    const ready = await new Promise((accept, reject) => {
      let output = '', bytes = 0, done = false;
      const finish = (error, value) => { if (done) return; done = true; output = ''; clearTimeout(timer); signal?.removeEventListener('abort', aborted); error ? reject(error) : accept(value); };
      const aborted = () => finish(new Error('OpenCode startup cancelled'));
      const timer = setTimeout(() => finish(new Error('OpenCode readiness timeout')), 15000);
      const data = chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) return finish(new Error('OpenCode readiness output exceeds limit'));
        output += chunk.toString();
        const endpoint = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        const password = output.match(/server password ([^\s]+)\r?\n/)?.[1];
        if (endpoint && password) finish(undefined, { endpoint, password });
      };
      child.stdout.on('data', data); child.stderr.on('data', data);
      child.once('error', () => finish(new Error('OpenCode server could not start')));
      child.once('exit', () => finish(new Error('OpenCode exited before readiness')));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    return { ...ready, close };
  } catch (error) { await close(); throw error; }
}
