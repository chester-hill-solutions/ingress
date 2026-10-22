/**
 * Look at what a design submission actually built.
 *
 * The mission's judge is a browser too, but its job is to decide twelve booleans and it never
 * shows anyone the product. This is the acceptance pass: start the cohort's server, visit it the
 * way a visitor would, open the dashboard the way an owner would, and keep the pictures and the
 * text. It asserts nothing -- it is the part where a human looks.
 *
 *   node scripts/mission-open-accept.mjs --workspace=DIR --out=DIR
 *
 * Writes `site.png`, `dashboard.png`, `dashboard.html` and `report.json` into `--out`, and prints
 * a summary. A server that does not start is reported as such, with its output, because that is
 * also a finding.
 */
import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { launchBrowser, browserAvailable } from '../src/browser.mjs';

const args = process.argv.slice(2);
const value = key => {
  const found = args.find(argument => argument.startsWith(`${key}=`));
  return found === undefined ? undefined : found.slice(key.length + 1);
};

const workspaceArg = value('--workspace');
const outArg = value('--out');
if (!workspaceArg || !outArg) {
  console.error('Usage: node scripts/mission-open-accept.mjs --workspace=DIR --out=DIR');
  process.exitCode = 1;
} else if (!browserAvailable()) {
  console.error('no browser on this machine; nothing to look at');
  process.exitCode = 1;
} else {
  const workspace = await realpath(resolve(workspaceArg));
  const out = resolve(outArg);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const server = spawn(process.execPath, ['--permission', `--allow-fs-read=${workspace}`, `--allow-fs-write=${workspace}`, '--allow-net', 'server.mjs'], {
    cwd: workspace,
    env: { PORT: String(port), PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, NODE_ENV: 'acceptance' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout?.on('data', chunk => logs.push(String(chunk)));
  server.stderr?.on('data', chunk => logs.push(String(chunk)));
  let browser;
  const report = { workspace, port, startedAt: new Date().toISOString(), ready: false };
  try {
    report.ready = await waitForServer(port, 10000);
    if (!report.ready) throw Error('the server did not answer within 10s');
    browser = await launchBrowser({ timeoutMs: 20000 });
    const base = `http://127.0.0.1:${port}`;

    // A visitor's visit: the same shape the judge drives, so the pictures show a used product.
    await browser.navigate(`${base}/`);
    await new Promise(done => setTimeout(done, 500));
    await browser.evaluate('(window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.6), window.scrollY)').catch(() => {});
    for (let index = 0; index < 4; index += 1) { await browser.click('#buy').catch(() => {}); await new Promise(done => setTimeout(done, 120)); }
    await browser.type('#email', 'owner@chesterhill.example').catch(() => {});
    await browser.type('#card', '4111 1111 1111 1111').catch(() => {});
    await browser.click('#explode').catch(() => {});
    await new Promise(done => setTimeout(done, 800));
    await browser.screenshot(join(out, 'site.png'));
    report.site = { requests: browser.requests.length, exceptions: browser.exceptions.map(exception => exception.text.slice(0, 200)) };

    await browser.navigate(`${base}/dashboard`);
    await new Promise(done => setTimeout(done, 400));
    await browser.screenshot(join(out, 'dashboard.png'));
    const html = await browser.evaluate('document.documentElement.outerHTML');
    const text = await browser.evaluate('document.body.innerText');
    await writeFile(join(out, 'dashboard.html'), html, { mode: 0o600 });
    report.dashboard = { bytes: Buffer.byteLength(html), text: String(text).slice(0, 4000) };

    // What the tag sent, which is the only place the design's vocabulary shows itself.
    report.wire = browser.requests
      .filter(request => request.method !== 'GET')
      .map(request => ({ url: request.url, body: String(request.body ?? '').slice(0, 600) }));
    await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

    console.log(`workspace: ${workspace}`);
    console.log(`screens:   ${join(out, 'site.png')}  ${join(out, 'dashboard.png')}`);
    console.log(`wire:      ${report.wire.length} POST(s), ${browser.requests.length} request(s) total`);
    console.log(`exceptions: ${report.site.exceptions.length}`);
    console.log('--- the dashboard, as text ---');
    console.log(String(text).trim().slice(0, 1200));
  } catch (error) {
    report.error = error.message;
    report.logs = logs.join('').slice(0, 2000);
    await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.error(`acceptance failed: ${error.message}`);
    if (report.logs) console.error(report.logs);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    try { server.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

async function waitForServer(port, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); if (response.status < 500) return true; } catch { /* not yet */ }
    await new Promise(done => setTimeout(done, 150));
  }
  return false;
}
