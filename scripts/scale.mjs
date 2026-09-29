import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runScale } from '../src/scale.mjs';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const field = { '--participants': 'participants', '--events': 'eventCount', '--batch-size': 'batchSize' }[args[index]];
  if (!field || index + 1 >= args.length || !/^\d+$/.test(args[index + 1]) || options[field] !== undefined) {
    throw new Error('Usage: node scripts/scale.mjs [--participants 32] [--events 2000] [--batch-size 100]');
  }
  options[field] = Number(args[index + 1]);
}
const evidence = { version: 1, date: new Date().toISOString(), ...await runScale(options) };
const output = resolve(import.meta.dirname, '../artifacts', `scale-${randomUUID()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const path = join(output, 'scale-evidence.json');
await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ kind: evidence.kind, participantCount: evidence.participantCount, events: evidence.events,
  dispatch_latency: evidence.dispatch_latency, context_compile_latency: evidence.context_compile_latency,
  update_to_context_latency: evidence.update_to_context_latency, context_size: evidence.context_size,
  routing: evidence.routing, coalescing: evidence.coalescing, native_sse: evidence.native_sse,
  adverse_checks: evidence.adverse_checks, limits: evidence.limits }));
console.log(`Evidence: ${path}`);
