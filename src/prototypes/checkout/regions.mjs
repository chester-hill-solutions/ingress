// Revision-relative line coordinates. This prototype deliberately refuses large diffs.
export const MAX_LINES = 1500;

export function lines(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw new TypeError('expected text without NUL bytes');
  const result = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (result.length > MAX_LINES) throw new RangeError('prototype_line_limit');
  return result;
}

// Return changes in ORIGINAL coordinates, including zero-width insertion points.
export function changes(baseText, nextText) {
  const a = lines(baseText), b = lines(nextText);
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0, pending = null;
  function flush() {
    if (pending) result.push({ ...pending, end: i, replacement: b.slice(pending.otherStart, j).join('') });
    pending = null;
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else {
      pending ??= { start: i, otherStart: j };
      if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) i++;
      else j++;
    }
  }
  flush();
  return result.map(({ otherStart, ...change }) => change);
}

export function intersects(a, b) {
  return a.path === b.path && a.start < b.end && b.start < a.end;
}

export function touches(change, scope, lineCount = Infinity) {
  // Insertion belongs to the line AFTER its gap. At EOF it belongs to the last line.
  return change.start === change.end
    ? scope.start <= Math.min(change.start, lineCount - 1) && Math.min(change.start, lineCount - 1) < scope.end
    : change.start < scope.end && scope.start < change.end;
}

export function covered(change, scopes, lineCount) {
  if (change.start === change.end) {
    const line = Math.min(change.start, Math.max(0, lineCount - 1));
    return scopes.some(scope => scope.start <= line && line < scope.end);
  }
  let cursor = change.start;
  for (const scope of [...scopes].sort((a, b) => a.start - b.start)) {
    if (scope.start > cursor) break;
    cursor = Math.max(cursor, scope.end);
    if (cursor >= change.end) return true;
  }
  return false;
}
