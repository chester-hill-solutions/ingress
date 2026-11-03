import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A real child executable, not a mocked kill call: startup must release both its
// process and its disposable profile even when Chrome never becomes usable.
for (const mode of ['connect-failure', 'no-endpoint', 'protocol-timeout']) {
  test(`browser startup cleans up after ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'browser-cleanup-test-'));
    const marker = join(root, 'child.json');
    const executable = join(root, 'fake-chrome');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const profile = process.argv.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, profile }));
${mode === 'connect-failure' ? "console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/fixture');" : ''}
${mode === 'protocol-timeout' ? `const server = require('node:http').createServer();
server.on('upgrade', (request, socket) => {
  const accept = require('node:crypto').createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.on('data', () => {}); // Connect successfully, then never answer CDP.
});
server.listen(0, '127.0.0.1', () => console.error('DevTools listening on ws://127.0.0.1:' + server.address().port + '/devtools/browser/fixture'));` : ''}
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    let record;
    t.after(async () => {
      try { record ??= JSON.parse(await readFile(marker, 'utf8')); } catch {}
      if (record) {
        try { process.kill(record.pid, 'SIGKILL'); } catch {}
        await rm(record.profile, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    });
    const source = `import { launchBrowser } from ${JSON.stringify(new URL('../src/browser.mjs', import.meta.url).href)};
try { await launchBrowser({ timeoutMs: 1000 }); process.exitCode = 2; }
catch (error) { console.log(error.message); }`;
    const driver = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, CHROME_PATH: executable }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timedOut = false;
    driver.stdout.on('data', chunk => { output += chunk; });
    driver.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; driver.kill('SIGKILL'); }, 5000);
    const code = await new Promise((resolve, reject) => {
      driver.once('error', reject);
      driver.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    record = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(timedOut, false, `startup left live handles: ${output}`);
    assert.equal(code, 0, output);
    assert.match(output, mode === 'connect-failure' ? /browser_connect_failed/
      : mode === 'protocol-timeout' ? /cdp_timeout:Target.createTarget/ : /browser_launch_timeout/);
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
    await assert.rejects(stat(record.profile), { code: 'ENOENT' });
  });
}
