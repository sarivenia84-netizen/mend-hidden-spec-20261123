// mend CLI — implements SPEC.md sections 1-4, 9, 10. Formats 6-8 + section 5 are parsed here.
// Node 22, stdlib only. Invoked as `node main.ts [options] [PATCH]`.
// Grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL; runner.ts hand-off at EOF must stay intact.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const ACCEPTED_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

class AbortParse {
  readonly message: string;
  constructor(message: string) { this.message = message; }
}

class EditFail {
  readonly reason: string;
  readonly file: string;
  constructor(reason: string, file: string) { this.reason = reason; this.file = file; }
}

const emptyLine = (t: string): boolean => t.trim() === '';

const rtrim = (t: string): string => t.replace(/[ \t]+$/, '');
const trimBoth = (t: string): string => rtrim(t.replace(/^[ \t]+/, ''));

/** Tier (SPEC §5) where pattern occurs in source, plus match positions. */
function locate(source: string[], pattern: string[], strict: boolean): { tier: number; at: number[] } | null {
  if (pattern.length === 0) {
    return { tier: 0, at: Array.from({ length: source.length + 1 }, (_, i) => i) };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = (s: string): string => tier === 0 ? s : tier === 1 ? rtrim(s) : trimBoth(s);
    const wanted = pattern.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + pattern.length <= source.length; i++) {
      let good = true;
      for (let j = 0; j < pattern.length; j++) {
        if (norm(source[i + j]!) !== wanted[j]) { good = false; break; }
      }
      if (good) hits.push(i);
    }
    if (hits.length > 0) return { tier, at: hits };
  }
  return null;
}

function validPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

function toPatchArray(raw: string): string[] {
  if (raw === '') return [];
  const chunks = raw.split('\n');
  if (raw.endsWith('\n')) chunks.pop();
  return chunks.map(c => c.endsWith('\r') ? c.slice(0, -1) : c);
}

/** Working tree snapshot: `current` holds edits (null = deleted), falls back to disk via `fetchOrig`. */
class WorkTree {
  #origin = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();
  readonly renames: [string, string][] = [];

  fetchOrig(p: string): string | null {
    if (!this.#origin.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch { v = null; }
      this.#origin.set(p, v);
    }
    return this.#origin.get(p)!;
  }
  read(p: string): string | null {
    return this.current.has(p) ? this.current.get(p)! : this.fetchOrig(p);
  }
}

type Op = (tree: WorkTree) => void;

function sniffFormat(arr: string[]): string | null {
  const firstNonBlank = arr.findIndex(l => !emptyLine(l));
  if (firstNonBlank < 0) return null;
  if (arr[firstNonBlank]!.trim() === '*** Begin Patch') return 'v4a';
  const head = arr[firstNonBlank]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (arr.some(l => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (arr.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (arr[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(payload: unknown): Op | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;

  const requireFile = (t: WorkTree): string => {
    if (!validPath(path)) throw new EditFail('unsafe', path);
    const content = t.read(path);
    if (content === null) throw new EditFail('missing', path);
    return content;
  };

  const cmd = obj.command;
  if (cmd === 'create' && typeof obj.file_text === 'string') {
    const fileText = obj.file_text;
    return (t: WorkTree) => {
      if (!validPath(path)) throw new EditFail('unsafe', path);
      if (t.read(path) !== null) throw new EditFail('exists', path);
      t.current.set(path, fileText);
    };
  }

  if (cmd === 'str_replace' && typeof obj.old_str === 'string' && obj.old_str !== '' &&
      (obj.new_str === undefined || typeof obj.new_str === 'string')) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (t: WorkTree) => {
      const original = requireFile(t);
      const firstNl = original.indexOf('\n');
      const isCrlf = firstNl > 0 && original[firstNl - 1] === '\r';
      const toLf = (s: string): string => isCrlf ? s.replaceAll('\r\n', '\n') : s;
      const src = toLf(original);
      const find = toLf(oldStr);
      let matches = 0;
      for (let idx = src.indexOf(find); idx >= 0; idx = src.indexOf(find, idx + 1)) {
        matches += 1;
      }
      if (matches === 0) throw new EditFail('no-match', path);
      if (matches > 1) throw new EditFail('ambiguous', path);
      const pos = src.indexOf(find);
      const result = src.slice(0, pos) + toLf(newStr) + src.slice(pos + find.length);
      t.current.set(path, isCrlf ? result.replaceAll('\n', '\r\n') : result);
    };
  }

  if (cmd === 'insert' && typeof obj.insert_line === 'number' && Number.isInteger(obj.insert_line) &&
      typeof obj.new_str === 'string') {
    const insertAt = obj.insert_line;
    const toInsert = toPatchArray(obj.new_str);
    return (t: WorkTree) => {
      const original = requireFile(t);
      const firstNl = original.indexOf('\n');
      const breakChar = firstNl > 0 && original[firstNl - 1] === '\r' ? '\r\n' : '\n';
      const lineArray = original === '' ? [] : original.split(breakChar);
      const hasTrailingBreak = original !== '' && original.endsWith(breakChar);
      if (hasTrailingBreak) lineArray.pop();
      if (insertAt < 0 || insertAt > lineArray.length) throw new EditFail('no-match', path);
      lineArray.splice(insertAt, 0, ...toInsert);
      const joined = lineArray.length === 0 ? '' : lineArray.join(breakChar) + (hasTrailingBreak ? breakChar : '');
      t.current.set(path, joined);
    };
  }

  return null;
}

function jsonEdits(patchText: string, patchLines: string[]): Op[] {
  const firstIdx = patchLines.findIndex((l) => !emptyLine(l));
  if (firstIdx < 0) throw new AbortParse('error: parse 1');
  const results: Op[] = [];
  const firstLine = patchLines[firstIdx]!.trimStart();
  if (firstLine.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new AbortParse(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(parsed)) throw new AbortParse(`error: parse ${firstIdx + 1}`);
    for (const item of parsed) {
      const edit = jsonEdit(item);
      if (edit === null) throw new AbortParse(`error: parse ${firstIdx + 1}`);
      results.push(edit);
    }
    return results;
  }
  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i]!;
    if (emptyLine(line)) continue;
    let edit: Op | null = null;
    try {
      edit = jsonEdit(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new AbortParse(`error: parse ${i + 1}`);
    results.push(edit);
  }
  return results;
}

/** The edits of the SEARCH/REPLACE blocks (SPEC.md section 7), in patch order. */
function searchReplaceEdits(sourceLines: string[], isStrict: boolean): Op[] {
  const result: Op[] = [];
  const isMarker = (line: string, target: string): boolean => rtrim(line) === target;

  let lastKnownPath: string | null = null;
  let afterLastBlock = 0;

  for (let idx = 0; idx < sourceLines.length; idx += 1) {
    if (!isMarker(sourceLines[idx]!, '<<<<<<< SEARCH')) continue;

    const searchStart = idx;
    const dividerIdx = sourceLines.findIndex((ln, j) => j > searchStart && isMarker(ln, '======='));
    const replaceEnd = dividerIdx < 0 ? -1 : sourceLines.findIndex((ln, j) => j > dividerIdx && isMarker(ln, '>>>>>>> REPLACE'));
    if (dividerIdx < 0 || replaceEnd < 0) throw new AbortParse(`error: parse ${searchStart + 1}`);

    let blockPath: string | null = null;
    for (let back = searchStart - 1; back >= afterLastBlock; back -= 1) {
      const candidate = sourceLines[back]!;
      if (emptyLine(candidate)) continue;
      const cleaned = trimBoth(candidate);
      if (cleaned.startsWith('```')) continue;
      blockPath = cleaned;
      break;
    }
    if (blockPath === null) blockPath = lastKnownPath;
    if (blockPath === null) throw new AbortParse(`error: parse ${searchStart + 1}`);

    const searchContent = sourceLines.slice(searchStart + 1, dividerIdx);
    const replaceContent = sourceLines.slice(dividerIdx + 1, replaceEnd);
    const targetPath = blockPath;

    result.push((tree: WorkTree) => {
      if (!validPath(targetPath)) throw new EditFail('unsafe', targetPath);

      if (searchContent.length === 0) {
        if (tree.read(targetPath) !== null) throw new EditFail('exists', targetPath);
        tree.current.set(targetPath, replaceContent.length === 0 ? '' : `${replaceContent.join('\n')}\n`);
        return;
      }

      const original = tree.read(targetPath);
      if (original === null) throw new EditFail('missing', targetPath);

      const firstNewline = original.indexOf('\n');
      const lineBreak = firstNewline > 0 && original[firstNewline - 1] === '\r' ? '\r\n' : '\n';
      const fileParts = original === '' ? [] : original.split(lineBreak);
      const hasTrailingBreak = original !== '' && original.endsWith(lineBreak);
      if (hasTrailingBreak) fileParts.pop();

      const match = locate(fileParts, searchContent, isStrict);
      if (match === null) throw new EditFail('no-match', targetPath);
      if (match.at.length > 1) throw new EditFail('ambiguous', targetPath);

      const insertAt = match.at[0]!;
      let outputLines = replaceContent;

      if (match.tier === 2) {
        const fileIndent = indentOf(fileParts[insertAt]!);
        const searchIndent = indentOf(searchContent[0]!);
        outputLines = replaceContent.map(ln =>
          ln.trim() !== '' && ln.startsWith(searchIndent) ? fileIndent + ln.slice(searchIndent.length) : ln
        );
      }

      fileParts.splice(insertAt, searchContent.length, ...outputLines);
      const rebuilt = fileParts.length === 0 ? '' : fileParts.join(lineBreak) + (hasTrailingBreak ? lineBreak : '');
      tree.current.set(targetPath, rebuilt);
    });

    lastKnownPath = blockPath;
    afterLastBlock = replaceEnd + 1;
    idx = replaceEnd;
  }

  return result;
}

// ---- Section 5 helpers shared by unified and V4A ----

const buildNormalizer = (level: number): ((s: string) => string) =>
  level === 0 ? (s) => s : level === 1 ? rtrim : trimBoth;

const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0];

interface Piece {
  t: 'ctx' | 'old' | 'new';
  s: string;
}

/** A file's lines, break kind, and whether it ends with a break. */
function parseFile(text: string): { lines: string[]; br: string; final: boolean } {
  const idx = text.indexOf('\n');
  const br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

const renderFile = (st: { lines: string[]; br: string; final: boolean }): string =>
  st.lines.length === 0 ? '' : st.lines.join(st.br) + (st.final ? st.br : '');

/** The lines written in place of O's matched lines, walking the body in order (context from the file; tier 2 reindents). */
function buildSegment(fileLines: string[], at: number, items: Piece[], level: number): string[] {
  const reindent = level === 2 && items.some((it) => it.t !== 'ctx');
  const F = reindent ? indentOf(fileLines[at]!) : '';
  const P = reindent ? indentOf(items[0]!.s) : '';
  const seg: string[] = [];
  let pos = at;
  for (const it of items) {
    if (it.t === 'ctx') { seg.push(fileLines[pos]!); pos++; }
    else if (it.t === 'old') pos++;
    else {
      const s = it.s;
      if (reindent && s.trim() !== '' && s.startsWith(P)) seg.push(F + s.slice(P.length));
      else seg.push(s);
    }
  }
  return seg;
}

// ---- Section 6: unified diffs ----

interface UHunk {
  start: number;
  items: { t: 'ctx' | 'old' | 'new' | 'bs'; s: string }[];
}

function parseHunkHeader(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

const trimAfterFour = (l: string): string => l.slice(4).split('\t')[0]!.trim();
const stripPrefix = (p: string): string => (p === '/dev/null' ? p : p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

interface USec {
  gitOld: string | null;
  gitNew: string | null;
  old: string | null;
  nw: string | null;
  renameOld: string | null;
  renameNew: string | null;
  create: boolean;
  del: boolean;
  sawPair: boolean;
  hunks: UHunk[];
}

function readSection(lines: string[], idx: number, sec: USec): number {
  while (idx < lines.length) {
    const l = lines[idx]!;
    const h = parseHunkHeader(l);
    if (h !== null) {
      idx += 1;
      const items: UHunk['items'] = [];
      while (idx < lines.length) {
        const c = lines[idx]!;
        if (c.startsWith('diff --git ') || (c.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ '))) break;
        if (c.startsWith(' ')) { items.push({ t: 'ctx', s: c.slice(1) }); idx += 1; }
        else if (c.startsWith('-')) { items.push({ t: 'old', s: c.slice(1) }); idx += 1; }
        else if (c.startsWith('+')) { items.push({ t: 'new', s: c.slice(1) }); idx += 1; }
        else if (c.startsWith('\\')) { items.push({ t: 'bs', s: c }); idx += 1; }
        else if (c === '') { items.push({ t: 'ctx', s: '' }); idx += 1; }
        else break;
      }
      while (items.length > 0 && items[items.length - 1]!.t === 'ctx' && items[items.length - 1]!.s === '') items.pop();
      sec.hunks.push({ start: h, items });
      continue;
    }
    if (l.startsWith('diff --git ')) return idx;
    if (l.startsWith('--- ')) {
      if ((lines[idx + 1] ?? '').startsWith('+++ ')) {
        if (sec.sawPair || sec.hunks.length > 0) return idx;
        sec.old = stripPrefix(trimAfterFour(l));
        sec.nw = stripPrefix(trimAfterFour(lines[idx + 1]!));
        sec.sawPair = true;
        idx += 2;
        continue;
      }
      throw new AbortParse(`error: parse ${idx + 2}`);
    }
    if (l.startsWith('rename from ')) { if (sec.renameOld === null) sec.renameOld = l.slice(12).trim(); idx += 1; continue; }
    if (l.startsWith('rename to ')) { if (sec.renameNew === null) sec.renameNew = l.slice(10).trim(); idx += 1; continue; }
    if (l.startsWith('new file mode')) { sec.create = true; idx += 1; continue; }
    if (l.startsWith('deleted file mode')) { sec.del = true; idx += 1; continue; }
    if (l.startsWith('@@')) throw new AbortParse(`error: parse ${idx + 1}`);
    idx += 1;
  }
  return idx;
}

function applyHunks(st: { lines: string[]; br: string; final: boolean }, hunks: UHunk[], path: string, strict: boolean): void {
  let delta = 0;
  const levels = strict ? [0] : [0, 1, 2];
  for (const h of hunks) {
    const oldPieces = h.items.filter((it) => it.t === 'ctx' || it.t === 'old').map((it) => ({ t: it.t === 'ctx' ? 'ctx' : 'old', s: it.s }) as Piece);
    const newPieces = h.items.filter((it) => it.t === 'ctx' || it.t === 'new').map((it) => ({ t: it.t === 'ctx' ? 'ctx' : 'new', s: it.s }) as Piece);
    let lastNewIdx = -1;
    for (let k = 0; k < h.items.length; k++) if (h.items[k]!.t === 'ctx' || h.items[k]!.t === 'new') lastNewIdx = k;
    const noNl = lastNewIdx >= 0 && h.items[lastNewIdx + 1]?.t === 'bs';
    let atEnd = false;
    if (oldPieces.length > 0) {
      const found = locate(st.lines, oldPieces.map((o) => o.s), strict);
      if (found === null) throw new EditFail('no-match', path);
      const target = h.start - 1 + delta;
      let best = found.at[0]!;
      for (const p of found.at) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      atEnd = best + oldPieces.length === st.lines.length;
      const seg = buildSegment(st.lines, best, h.items.filter((it) => it.t !== 'bs').map((it) => ({ t: it.t === 'bs' ? 'ctx' : it.t, s: it.s }) as Piece), found.tier);
      st.lines.splice(best, oldPieces.length, ...seg);
    } else {
      const pos = Math.min(h.start + delta, st.lines.length);
      atEnd = pos >= st.lines.length;
      st.lines.splice(pos, 0, ...newPieces.map((it) => it.s));
    }
    if (atEnd) st.final = !noNl;
    delta += newPieces.length - oldPieces.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Op[] {
  const result: Op[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: USec;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new AbortParse(`error: parse ${i + 1}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, old: null, nw: null, renameOld: null, renameNew: null, create: false, del: false, sawPair: false, hunks: [] };
      i = readSection(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { gitOld: null, gitNew: null, old: null, nw: null, renameOld: null, renameNew: null, create: false, del: false, sawPair: false, hunks: [] };
      sec.old = stripPrefix(trimAfterFour(l));
      sec.nw = stripPrefix(trimAfterFour(lines[i + 1]!));
      sec.sawPair = true;
      i = readSection(lines, i + 2, sec);
    } else {
      i += 1;
      continue;
    }
    const old = sec.old ?? sec.renameOld ?? sec.gitOld;
    const nw = sec.nw ?? sec.renameNew ?? sec.gitNew;
    if (sec.create || old === '/dev/null') {
      if (nw === null || nw === '/dev/null') continue;
      const p = nw;
      result.push((tree) => {
        if (!validPath(p)) throw new EditFail('unsafe', p);
        if (tree.read(p) !== null) throw new EditFail('exists', p);
        const flat = sec.hunks.flatMap((h) => h.items);
        const plus: string[] = [];
        let lastNew = -1;
        for (let k = 0; k < flat.length; k++) {
          if (flat[k]!.t === 'new') { plus.push(flat[k]!.s); lastNew = k; }
        }
        const noNl = lastNew >= 0 && flat[lastNew + 1]?.t === 'bs';
        tree.current.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      });
      continue;
    }
    if (sec.del || nw === '/dev/null') {
      if (old === null) continue;
      const p = old;
      result.push((tree) => {
        if (!validPath(p)) throw new EditFail('unsafe', p);
        if (tree.read(p) === null) throw new EditFail('missing', p);
        tree.current.set(p, null);
      });
      continue;
    }
    if (old !== null && nw !== null && old !== nw) {
      result.push((tree) => {
        if (!validPath(old)) throw new EditFail('unsafe', old);
        if (!validPath(nw)) throw new EditFail('unsafe', nw);
        const before = tree.read(old);
        if (before === null) throw new EditFail('missing', old);
        if (tree.read(nw) !== null) throw new EditFail('exists', nw);
        const st = parseFile(before);
        applyHunks(st, sec.hunks, old, strict);
        tree.current.set(old, null);
        tree.current.set(nw, renderFile(st));
        tree.renames.push([old, nw]);
      });
      continue;
    }
    const p = old ?? nw;
    if (p === null || p === '/dev/null') continue;
    result.push((tree) => {
      if (!validPath(p)) throw new EditFail('unsafe', p);
      if (tree.read(p) === null) throw new EditFail('missing', p);
      const st = parseFile(tree.read(p)!);
      applyHunks(st, sec.hunks, p, strict);
      tree.current.set(p, renderFile(st));
    });
  }
  return result;
}

// ---- Section 8: V4A patches ----

interface PatchSegment {
  mark: string | null;
  parts: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  isEof: boolean;
}

function executeSegment(
  state: { lines: string[]; br: string; final: boolean },
  seg: PatchSegment,
  target: string,
  strictMode: boolean,
  offset: number
): number {
  let pos = offset;
  const levelList = strictMode ? [0] : [0, 1, 2];

  if (seg.mark !== null && seg.mark !== '') {
    let foundIdx = -1;
    for (const lvl of levelList) {
      const fn = buildNormalizer(lvl);
      const needle = fn(seg.mark);
      for (let scan = pos; scan < state.lines.length; scan++) {
        if (fn(state.lines[scan]!) === needle) { foundIdx = scan; break; }
      }
      if (foundIdx >= 0) break;
    }
    if (foundIdx < 0) throw new EditFail('no-match', target);
    pos = foundIdx + 1;
  }

  const oldParts = seg.parts.filter(p => p.kind !== 'new').map(p => ({ t: p.kind as 'ctx' | 'old', s: p.text }) as Piece);
  const newParts = seg.parts.filter(p => p.kind !== 'old').map(p => ({ t: p.kind as 'ctx' | 'new', s: p.text }) as Piece);

  if (oldParts.length === 0) {
    const insertAt = seg.isEof ? state.lines.length : Math.min(pos, state.lines.length);
    state.lines.splice(insertAt, 0, ...newParts.map(p => p.s));
    return insertAt + newParts.length;
  }

  let matchAt = -1;
  let matchLevel = 0;
  for (const lvl of levelList) {
    const fn = buildNormalizer(lvl);
    const searchFor = oldParts.map(x => fn(x.s));
    for (let start = pos; start + oldParts.length <= state.lines.length; start++) {
      if (seg.isEof && start + oldParts.length !== state.lines.length) continue;
      let ok = true;
      for (let j = 0; j < searchFor.length; j++) {
        if (fn(state.lines[start + j]!) !== searchFor[j]) { ok = false; break; }
      }
      if (ok) { matchAt = start; matchLevel = lvl; break; }
    }
    if (matchAt >= 0) break;
  }
  if (matchAt < 0) throw new EditFail('no-match', target);

  const rebuilt = buildSegment(state.lines, matchAt, seg.parts.map(p => ({ t: p.kind, s: p.text })) as Piece[], matchLevel);
  state.lines.splice(matchAt, oldParts.length, ...rebuilt);
  return matchAt + newParts.length;
}

function parseV4aPatch(srcLines: string[], strictMode: boolean): Op[] {
  const beginIdx = srcLines.findIndex(l => !emptyLine(l));
  if (beginIdx < 0 || srcLines[beginIdx]!.trim() !== '*** Begin Patch') {
    throw new AbortParse(`error: parse ${beginIdx < 0 ? 1 : beginIdx + 1}`);
  }
  let endIdx = -1;
  for (let i = srcLines.length - 1; i >= 0; i--) {
    if (!emptyLine(srcLines[i]!)) { endIdx = i; break; }
  }
  if (endIdx < 0 || srcLines[endIdx]!.trim() !== '*** End Patch') {
    throw new AbortParse(`error: parse ${srcLines.length + 1}`);
  }

  const results: Op[] = [];
  const isHeader = (ln: string) =>
    ln.startsWith('*** Add File: ') || ln.startsWith('*** Delete File: ') || ln.startsWith('*** Update File: ');

  const sectionLimit = (idx: number) => {
    let lim = idx;
    while (lim < endIdx && !isHeader(srcLines[lim]!)) lim++;
    return lim;
  };

  let cursor = beginIdx + 1;
  while (cursor < endIdx) {
    const line = srcLines[cursor]!;
    if (emptyLine(line)) { cursor++; continue; }

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const limit = sectionLimit(cursor + 1);
      let trimEnd = limit;
      while (trimEnd > cursor + 1 && emptyLine(srcLines[trimEnd - 1]!)) trimEnd--;

      const fileLines: string[] = [];
      for (let k = cursor + 1; k < trimEnd; k++) {
        const ln = srcLines[k]!;
        if (ln.startsWith('+')) fileLines.push(ln.slice(1));
        else if (emptyLine(ln)) fileLines.push('');
        else throw new AbortParse(`error: parse ${k + 1}`);
      }

      results.push((tree) => {
        if (!validPath(path)) throw new EditFail('unsafe', path);
        if (tree.read(path) !== null) throw new EditFail('exists', path);
        tree.current.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
      cursor = limit;
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      const limit = sectionLimit(cursor + 1);
      for (let k = cursor + 1; k < limit; k++) {
        if (!emptyLine(srcLines[k]!)) throw new AbortParse(`error: parse ${k + 1}`);
      }
      results.push((tree) => {
        if (!validPath(path)) throw new EditFail('unsafe', path);
        if (tree.read(path) === null) throw new EditFail('missing', path);
        tree.current.set(path, null);
      });
      cursor = limit;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const limit = sectionLimit(cursor + 1);
      let trimEnd = limit;
      while (trimEnd > cursor + 1 && emptyLine(srcLines[trimEnd - 1]!)) trimEnd--;

      const body = srcLines.slice(cursor + 1, trimEnd);
      let scan = 0;
      while (scan < body.length && emptyLine(body[scan]!)) scan++;

      let renameTarget: string | null = null;
      if (scan < body.length && body[scan]!.startsWith('*** Move to: ')) {
        renameTarget = body[scan]!.slice(13).trim();
        scan++;
      }

      const segments: PatchSegment[] = [];
      while (scan < body.length) {
        const ln = body[scan]!;
        let mark: string | null = null;
        if (ln.startsWith('@@')) { mark = ln.slice(2).trim(); scan++; }
        else if (segments.length === 0) mark = '';
        else throw new AbortParse(`error: parse ${cursor + 2 + scan}`);

        const parts: PatchSegment['parts'] = [];
        let atEof = false;
        while (scan < body.length) {
          const ln2 = body[scan]!;
          if (ln2 === '*** End of File') { atEof = true; scan++; break; }
          if (ln2.startsWith('@@')) break;
          if (ln2.startsWith('*** ')) throw new AbortParse(`error: parse ${cursor + 2 + scan}`);
          if (ln2.startsWith(' ')) parts.push({ kind: 'ctx', text: ln2.slice(1) });
          else if (ln2.startsWith('-')) parts.push({ kind: 'old', text: ln2.slice(1) });
          else if (ln2.startsWith('+')) parts.push({ kind: 'new', text: ln2.slice(1) });
          else if (ln2 === '') parts.push({ kind: 'ctx', text: '' });
          else throw new AbortParse(`error: parse ${cursor + 2 + scan}`);
          scan++;
        }
        segments.push({ mark, parts, isEof: atEof });
      }

      if (segments.length === 0 && renameTarget === null) throw new AbortParse(`error: parse ${cursor + 1}`);

      results.push((tree) => {
        if (!validPath(path)) throw new EditFail('unsafe', path);
        if (renameTarget !== null && !validPath(renameTarget)) throw new EditFail('unsafe', renameTarget);
        const original = tree.read(path);
        if (original === null) throw new EditFail('missing', path);
        const state = parseFile(original);
        let pos = 0;
        for (const seg of segments) pos = executeSegment(state, seg, path, strictMode, pos);
        const finalText = renderFile(state);
        if (renameTarget !== null) {
          if (tree.read(renameTarget) !== null) throw new EditFail('exists', renameTarget);
          tree.current.set(path, null);
          tree.current.set(renameTarget, finalText);
          tree.renames.push([path, renameTarget]);
        } else tree.current.set(path, finalText);
      });
      cursor = limit;
      continue;
    }

    throw new AbortParse(`error: parse ${cursor + 1}`);
  }
  return results;
}

function run(args: string[]): { code: number; out: string[] } {
  let chosenFormat: string | null = null;
  let dryRun = false;
  let strictMode = false;
  const positional: string[] = [];
  let seenDoubleDash = false;

  for (const arg of args) {
    if (!seenDoubleDash && arg === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (!seenDoubleDash && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && chosenFormat === null && ACCEPTED_FORMATS.includes(arg.slice(9) as typeof ACCEPTED_FORMATS[number])) {
        chosenFormat = arg.slice(9);
      } else if (arg === '--check' && !dryRun) {
        dryRun = true;
      } else if (arg === '--strict' && !strictMode) {
        strictMode = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let rawText = '';
  try {
    rawText = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const patchLineArray = toPatchArray(rawText);
  const detectedKind = chosenFormat === null || chosenFormat === 'auto' ? sniffFormat(patchLineArray) : chosenFormat;
  if (detectedKind === null) return { code: 2, out: ['error: format'] };

  let edits: Op[];
  try {
    if (detectedKind === 'json') edits = jsonEdits(rawText, patchLineArray);
    else if (detectedKind === 'search-replace') edits = searchReplaceEdits(patchLineArray, strictMode);
    else if (detectedKind === 'unified') edits = unifiedEdits(patchLineArray, strictMode);
    else if (detectedKind === 'v4a') edits = parseV4aPatch(patchLineArray, strictMode);
    else edits = [];

    if (edits.length === 0) throw new AbortParse('error: parse 1');
  } catch (e) {
    if (e instanceof AbortParse) return { code: 2, out: [e.message] };
    throw e;
  }

  const workingTree = new WorkTree();
  const failedEdits: EditFail[] = [];

  for (const edit of edits) {
    const snapshot = new Map(workingTree.current);
    try {
      edit(workingTree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      workingTree.current.clear();
      for (const [key, value] of snapshot) workingTree.current.set(key, value);
      failedEdits.push(e);
    }
  }

  if (failedEdits.length > 0) {
    const messages = failedEdits.map(f => `error: ${f.reason} ${f.file}`);
    messages.push(`failed: ${failedEdits.length} of ${edits.length} edits`);
    return { code: 1, out: messages };
  }

  const statusMap = new Map<string, string>();

  const sortedPaths = [...workingTree.current.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const path of sortedPaths) {
    const originalContent = workingTree.fetchOrig(path);
    const newContent = workingTree.current.get(path)!;
    if (originalContent === newContent) continue;
    const code = originalContent === null ? 'A' : newContent === null ? 'D' : 'M';
    statusMap.set(path, `${code} ${path}`);
  }

  for (const [oldPath, newPath] of workingTree.renames) {
    if (statusMap.get(oldPath) === `D ${oldPath}` && statusMap.get(newPath) === `A ${newPath}`) {
      statusMap.delete(oldPath);
      statusMap.set(newPath, `R ${oldPath} -> ${newPath}`);
    }
  }

  const outputLines: string[] = [];
  const sortedStatusPaths = [...statusMap.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  for (const path of sortedStatusPaths) {
    const row = statusMap.get(path)!;
    outputLines.push(row);
    if (dryRun) continue;

    if (row.startsWith('R ')) {
      const arrowIndex = row.indexOf(' -> ');
      const from = row.slice(2, arrowIndex);
      const to = row.slice(arrowIndex + 4);
      rmSync(from, { force: true });
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, workingTree.current.get(path)!);
    } else {
      const content = workingTree.current.get(path)!;
      if (content === null) {
        rmSync(path, { force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }
  }

  outputLines.push(`ok: ${outputLines.length} ${outputLines.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: outputLines };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
