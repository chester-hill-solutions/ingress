// Optional offline adapter. Core tests do not launch Python or Graphify.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { hashText } from '../../src/prototypes/checkout/impact.mjs';
export function extractBindings(files, python) {
  const result = spawnSync(python, [resolve(import.meta.dirname, 'bindings.py')], {
    input: JSON.stringify(files), encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.error || result.status !== 0) throw new Error(`binding_producer_failed: ${result.error?.message ?? result.stderr}`);
  const ast = JSON.parse(result.stdout);
  for (const file of ast.files) {
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: files[file.path], encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024,
    });
    file.runtimeSyntaxValid = !syntax.error && syntax.status === 0;
  }
  ast.runtimeParser = 'node-module-syntax-check';
  ast.runtimeAdapterHash = hashText(readFileSync(new URL(import.meta.url)));
  return ast;
}
