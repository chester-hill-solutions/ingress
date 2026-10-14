#!/usr/bin/env node
// Materialize the tracked corpus as a fresh standalone Git repository; never overwrite.
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: { destination: { type: 'string' } } });
const root = resolve(import.meta.dirname, '../..');
const template = resolve(root, 'fixtures/checkout-lab');
const destination = resolve(values.destination ?? resolve(root, '../checkout-arbiter-lab'));
const within = relative(root, destination);
if (!within || (!within.startsWith('../') && !isAbsolute(within))) {
  throw new Error('Choose a destination outside the Ingress repository; nested Git repositories are not created');
}
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination); // EEXIST refuses without altering an existing project.
await cp(template, destination, { recursive: true, filter: path => !path.includes('/artifacts/') && !path.endsWith('/artifacts') });
const git = spawnSync('git', ['init', destination], { encoding: 'utf8' });
if (git.status !== 0) throw new Error(`git_init_failed: ${git.stderr}`);
const files = [];
async function walk(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'artifacts') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else {
      const bytes = await readFile(path);
      files.push({ path: relative(destination, path), sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk(destination);
console.log(JSON.stringify({ repository: destination, files: files.length,
  corpusHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  initialized: true, committed: false, remoteCreated: false, source: template }, null, 2));
