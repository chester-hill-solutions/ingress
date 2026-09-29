import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'artifacts'].includes(entry.name)) continue;
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) { await walk(file); continue; }
    const text = await readFile(file, 'utf8');
    if (file.endsWith('.mjs') && /(?:import|export)[^\n]*(?:stow-s3\/dist|\.\.\/\.\.\/packages|WebProjects\/stow)/.test(text))
      throw new Error('Private Stow import: ' + file);
    if (file.endsWith('.md')) for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || link.includes('://')) continue;
      try { await readFile(resolve(dirname(file), link)); } catch { throw new Error('Broken local link: ' + file + ' -> ' + link); }
    }
  }
}
await walk(root);
console.log('Repository boundary and local links OK');
