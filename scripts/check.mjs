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
    checkReporterLiteral(file, text);
    if (file.endsWith('.md')) for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || link.includes('://')) continue;
      try { await readFile(resolve(dirname(file), link)); } catch { throw new Error('Broken local link: ' + file + ' -> ' + link); }
    }
  }
}

/**
 * The in-container reporter is a template literal, so a backtick inside it — including in a
 * comment — terminates the literal and the module fails to parse with an error pointing at
 * unrelated code.
 *
 * This is a *text* check on purpose. A test cannot do this job: the failure mode is a parse
 * error, so the module never loads and every test importing it fails to run rather than
 * reporting the cause. `test/product-launcher.test.mjs` asserts the reporter parses, which
 * covers the case where something else breaks it — but not this, because nothing gets far
 * enough to run a test.
 *
 * It has happened four times in one session, each time in a comment, each time with the
 * error pointing somewhere unrelated.
 */
function checkReporterLiteral(file, text) {
  const open = text.match(/^export const CONTAINER_REPORTER = String\.raw`$/m);
  if (!open) return;
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^export const CONTAINER_REPORTER = String\.raw`$/.test(line));
  const end = lines.findIndex((line, i) => i > start && line.trim() === '`;');
  if (end === -1) return;

  const offending = lines
    .slice(start + 1, end)
    .map((line, i) => ({ line: i + start + 2, text: line }))
    .filter(entry => entry.text.includes('`'));

  if (offending.length > 0) {
    throw new Error(
      `Backtick inside the CONTAINER_REPORTER template literal (${file}:${offending.map(o => o.line).join(', ')}). `
      + 'It terminates the literal and breaks the module. Use plain quotes in comments there.',
    );
  }
}
await walk(root);
console.log('Repository boundary, local links, and the reporter literal OK');
