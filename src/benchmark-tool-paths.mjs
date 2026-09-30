/** Metadata extraction only: never returns patch content or asserts that a diff applied.
 * Self-contained so the exact function can be embedded in the native plugin.
 */
export function extractBenchmarkToolPaths(input, tool = null) {
  const paths = [], seen = new Set();
  const result = complete => ({ paths, complete });
  const add = value => {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    if (!seen.has(value)) {
      if (paths.length >= 64) return false;
      seen.add(value); paths.push(value);
    }
    return true;
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result(false);
  if (typeof input.value === 'string') {
    if (Buffer.byteLength(input.value) > 256 * 1024) return result(false);
    try { input = JSON.parse(input.value); } catch { return result(false); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result(false);
  }
  if (tool !== 'patch' && !Object.hasOwn(input, 'patchText')) {
    const aliases = [input.path, input.filePath, input.file_path].filter(value => value !== undefined);
    let complete = aliases.length > 0;
    for (const value of aliases) if (!add(value)) complete = false;
    return result(complete && paths.length === 1);
  }
  const patch = input.patchText;
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 256 * 1024) return result(false);
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return result(false);
  let operation = null, body = false, move = false, complete = true;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.*)$/.exec(line);
    if (header) {
      if (operation === 'Update' && !body) complete = false;
      if (!add(header[2])) complete = false;
      operation = header[1]; body = false; move = false; continue;
    }
    const destination = /^\*\*\* Move to: (.*)$/.exec(line);
    if (destination) {
      if (operation !== 'Update' || body || move) complete = false;
      if (!add(destination[1])) complete = false;
      move = true; continue;
    }
    if (!operation || line.startsWith('*** ') && line !== '*** End of File') { complete = false; continue; }
    if (operation === 'Delete') { complete = false; continue; }
    if (operation === 'Add') { if (!line.startsWith('+')) complete = false; body = true; continue; }
    if (line === '*** End of File' || line.startsWith('@@') || /^[ +\-]/.test(line)) body = true;
    else complete = false;
  }
  if (!operation || operation === 'Update' && !body || !paths.length) complete = false;
  return result(complete);
}
