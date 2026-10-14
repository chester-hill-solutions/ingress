import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const name of (await readdir(resolve(root, 'src'))).sort()) {
  const bytes = await readFile(resolve(root, 'src', name));
  files.push({ path: `src/${name}`, bytes: bytes.length, sha256: hash(bytes) });
}
const contracts = await readFile(resolve(root, 'contracts.json'));
const cases = await readFile(resolve(root, 'test/checkout-cases.json'));
console.log(JSON.stringify({ schema: 1, corpus: 'checkout-lab-v1', files,
  contractsHash: hash(contracts), caseOracleHash: hash(cases), revision: hash(JSON.stringify(files)),
  modelTrialsRun: 0, graphAuthorityQualified: false }, null, 2));
