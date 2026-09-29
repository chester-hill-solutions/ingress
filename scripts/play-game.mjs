import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../examples/canada-crossroads');
const { createGameServer } = await import(pathToFileURL(resolve(root, 'server.mjs')));
const server = await createGameServer({ host: '127.0.0.1', port: 0 });
console.log(`Canada: Crossroads · ${server.url}`);
let closing = false;
async function close() { if (closing) return; closing = true; await server.close(); }
process.once('SIGINT', close); process.once('SIGTERM', close);
