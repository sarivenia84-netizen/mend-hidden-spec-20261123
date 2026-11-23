// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const SUPPORTED_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseExit {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

const trimTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const trimEdges = (s: string): string => trimTrailing(s.replace(/^[ \t]+/, ''));

/** The first tier (SPEC.md section 5) at which O occurs in the file, and its positions. */
function locateLines(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  if (oldLines.length === 0) return { tier: 0, positions: Array.from({ length: fileLines.length + 1 }, (_, i) => i) };
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? trimTrailing(s) : trimEdges(s));
    const old = oldLines.map(norm);
    const positions: number[] = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
      let hit = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (norm(fileLines[i + j]!) !== old[j]) {
          hit = false;
          break;
        }
      }
      if (hit) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(payload: unknown): Edit | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;

  const requireFile = (t: Tree): string => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const content = t.get(path);
    if (content === null) throw new Fail('missing', path);
    return content;
  };

  const cmd = obj.command;
  if (cmd === 'create' && typeof obj.file_text === 'string') {
    const fileText = obj.file_text;
    return (t: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (t.get(path) !== null) throw new Fail('exists', path);
      t.now.set(path, fileText);
    };
  }

  if (cmd === 'str_replace' && typeof obj.old_str === 'string' && obj.old_str !== '' &&
      (obj.new_str === undefined || typeof obj.new_str === 'string')) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (t: Tree) => {
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
      if (matches === 0) throw new Fail('no-match', path);
      if (matches > 1) throw new Fail('ambiguous', path);
      const pos = src.indexOf(find);
      const result = src.slice(0, pos) + toLf(newStr) + src.slice(pos + find.length);
      t.now.set(path, isCrlf ? result.replaceAll('\n', '\r\n') : result);
    };
  }

  if (cmd === 'insert' && typeof obj.insert_line === 'number' && Number.isInteger(obj.insert_line) &&
      typeof obj.new_str === 'string') {
    const insertAt = obj.insert_line;
    const toInsert = patchLines(obj.new_str);
    return (t: Tree) => {
      const original = requireFile(t);
      const firstNl = original.indexOf('\n');
      const breakChar = firstNl > 0 && original[firstNl - 1] === '\r' ? '\r\n' : '\n';
      const lineArray = original === '' ? [] : original.split(breakChar);
      const hasTrailingBreak = original !== '' && original.endsWith(breakChar);
      if (hasTrailingBreak) lineArray.pop();
      if (insertAt < 0 || insertAt > lineArray.length) throw new Fail('no-match', path);
      lineArray.splice(insertAt, 0, ...toInsert);
      const joined = lineArray.length === 0 ? '' : lineArray.join(breakChar) + (hasTrailingBreak ? breakChar : '');
      t.now.set(path, joined);
    };
  }

  return null;
}

function jsonEdits(patchText: string, patchLines: string[]): Edit[] {
  const firstIdx = patchLines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new ParseExit('error: parse 1');
  const results: Edit[] = [];
  const firstLine = patchLines[firstIdx]!.trimStart();
  if (firstLine.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseExit(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseExit(`error: parse ${firstIdx + 1}`);
    for (const item of parsed) {
      const edit = jsonEdit(item);
      if (edit === null) throw new ParseExit(`error: parse ${firstIdx + 1}`);
      results.push(edit);
    }
    return results;
  }
  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i]!;
    if (isBlank(line)) continue;
    let edit: Edit | null = null;
    try {
      edit = jsonEdit(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseExit(`error: parse ${i + 1}`);
    results.push(edit);
  }
  return results;
}

/** The edits of the SEARCH/REPLACE blocks (SPEC.md section 7), in patch order. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const marker = (l: string, m: string): boolean => trimTrailing(l) === m;
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!marker(lines[i]!, '<<<<<<< SEARCH')) continue;
    const search = i;
    const eq = lines.findIndex((l, j) => j > search && marker(l, '======='));
    const rep = eq < 0 ? -1 : lines.findIndex((l, j) => j > eq && marker(l, '>>>>>>> REPLACE'));
    if (eq < 0 || rep < 0) throw new ParseExit(`error: parse ${search + 1}`);
    let path: string | null = null;
    for (let j = search - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      const trimmed = trimEdges(cand);
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseExit(`error: parse ${search + 1}`);
    const oldLines = lines.slice(search + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const fileLines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) fileLines.pop();
      const found = locateLines(fileLines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      let outLines = newLines;
      if (found.tier === 2) {
        const indent = (s: string): string => /^[ \t]*/.exec(s)![0];
        const f = indent(fileLines[at]!);
        const pIndent = indent(oldLines[0]!);
        outLines = newLines.map((l) => (l.trim() !== '' && l.startsWith(pIndent) ? f + l.slice(pIndent.length) : l));
      }
      fileLines.splice(at, oldLines.length, ...outLines);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join(br) + (final ? br : ''));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep;
  }
  return edits;
}

// ---- Section 5 helpers shared by unified and V4A ----

const tierNormalizer = (tier: number): ((s: string) => string) =>
  tier === 0 ? (s) => s : tier === 1 ? trimTrailing : trimEdges;
const leadingIndent = (s: string): string => /^[ \t]*/.exec(s)![0];

interface Piece {
  t: 'ctx' | 'old' | 'new';
  s: string;
}

/** A file's lines, break kind, and whether it ends with a break. */
function fileState(t: string): { lines: string[]; br: string; final: boolean } {
  const nl = t.indexOf('\n');
  const br = nl > 0 && t[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = t === '' ? [] : t.split(br);
  const final = t !== '' && t.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

const fileText = (st: { lines: string[]; br: string; final: boolean }): string =>
  st.lines.length === 0 ? '' : st.lines.join(st.br) + (st.final ? st.br : '');

/** The lines written in place of O's matched lines, walking the body in order (context from the file; tier 2 reindents). */
function bodySegment(fileLines: string[], at: number, items: Piece[], tier: number): string[] {
  const reindent = tier === 2 && items.some((it) => it.t !== 'ctx');
  const F = reindent ? leadingIndent(fileLines[at]!) : '';
  const P = reindent ? leadingIndent(items[0]!.s) : '';
  const seg: string[] = [];
  let pos = at;
  for (const it of items) {
    if (it.t === 'ctx') { seg.push(fileLines[pos]!); pos += 1; }
    else if (it.t === 'old') pos += 1;
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
  a: number;
  items: { t: 'ctx' | 'old' | 'new' | 'bs'; s: string }[];
}

function extractHunkLine(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

const afterFour = (l: string): string => l.slice(4).split('\t')[0]!.trim();
const stripAB = (p: string): string => (p === '/dev/null' ? p : p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

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

function parseSection(lines: string[], i: number, sec: USec): number {
  while (i < lines.length) {
    const l = lines[i]!;
    const a = extractHunkLine(l);
    if (a !== null) {
      i += 1;
      const items: UHunk['items'] = [];
      while (i < lines.length) {
        const c = lines[i]!;
        if (c.startsWith('diff --git ') || (c.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (c.startsWith(' ')) { items.push({ t: 'ctx', s: c.slice(1) }); i += 1; }
        else if (c.startsWith('-')) { items.push({ t: 'old', s: c.slice(1) }); i += 1; }
        else if (c.startsWith('+')) { items.push({ t: 'new', s: c.slice(1) }); i += 1; }
        else if (c.startsWith('\\')) { items.push({ t: 'bs', s: c }); i += 1; }
        else if (c === '') { items.push({ t: 'ctx', s: '' }); i += 1; }
        else break;
      }
      while (items.length > 0 && items[items.length - 1]!.t === 'ctx' && items[items.length - 1]!.s === '') items.pop();
      sec.hunks.push({ a, items });
      continue;
    }
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.sawPair || sec.hunks.length > 0) return i;
        sec.old = stripAB(afterFour(l));
        sec.nw = stripAB(afterFour(lines[i + 1]!));
        sec.sawPair = true;
        i += 2;
        continue;
      }
      throw new ParseExit(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) { if (sec.renameOld === null) sec.renameOld = l.slice(12).trim(); i += 1; continue; }
    if (l.startsWith('rename to ')) { if (sec.renameNew === null) sec.renameNew = l.slice(10).trim(); i += 1; continue; }
    if (l.startsWith('new file mode')) { sec.create = true; i += 1; continue; }
    if (l.startsWith('deleted file mode')) { sec.del = true; i += 1; continue; }
    if (l.startsWith('@@')) throw new ParseExit(`error: parse ${i + 1}`);
    i += 1;
  }
  return i;
}

function applyHunks(st: { lines: string[]; br: string; final: boolean }, hunks: UHunk[], path: string, strict: boolean): void {
  let d = 0;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const h of hunks) {
    const O = h.items.filter((it) => it.t === 'ctx' || it.t === 'old').map((it) => ({ t: it.t === 'ctx' ? 'ctx' : 'old', s: it.s }) as Piece);
    const N = h.items.filter((it) => it.t === 'ctx' || it.t === 'new').map((it) => ({ t: it.t === 'ctx' ? 'ctx' : 'new', s: it.s }) as Piece);
    let lastCn = -1;
    for (let k = 0; k < h.items.length; k += 1) if (h.items[k]!.t === 'ctx' || h.items[k]!.t === 'new') lastCn = k;
    const noNl = lastCn >= 0 && h.items[lastCn + 1]?.t === 'bs';
    let endAtEnd = false;
    if (O.length > 0) {
      const found = locateLines(st.lines, O.map((o) => o.s), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      endAtEnd = best + O.length === st.lines.length;
      const seg = bodySegment(st.lines, best, h.items.filter((it) => it.t !== 'bs').map((it) => ({ t: it.t === 'bs' ? 'ctx' : it.t, s: it.s }) as Piece), found.tier);
      st.lines.splice(best, O.length, ...seg);
    } else {
      const pos = Math.min(h.a + d, st.lines.length);
      endAtEnd = pos >= st.lines.length;
      st.lines.splice(pos, 0, ...N.map((it) => it.s));
    }
    if (endAtEnd) st.final = !noNl;
    d += N.length - O.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: USec;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new ParseExit(`error: parse ${i + 1}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, old: null, nw: null, renameOld: null, renameNew: null, create: false, del: false, sawPair: false, hunks: [] };
      i = parseSection(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { gitOld: null, gitNew: null, old: null, nw: null, renameOld: null, renameNew: null, create: false, del: false, sawPair: false, hunks: [] };
      sec.old = stripAB(afterFour(l));
      sec.nw = stripAB(afterFour(lines[i + 1]!));
      sec.sawPair = true;
      i = parseSection(lines, i + 2, sec);
    } else {
      i += 1;
      continue;
    }
    const old = sec.old ?? sec.renameOld ?? sec.gitOld;
    const nw = sec.nw ?? sec.renameNew ?? sec.gitNew;
    if (sec.create || old === '/dev/null') {
      if (nw === null || nw === '/dev/null') continue;
      const p = nw;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const flat = sec.hunks.flatMap((h) => h.items);
        const plus: string[] = [];
        let lastNew = -1;
        for (let k = 0; k < flat.length; k += 1) {
          if (flat[k]!.t === 'new') { plus.push(flat[k]!.s); lastNew = k; }
        }
        const noNl = lastNew >= 0 && flat[lastNew + 1]?.t === 'bs';
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      });
      continue;
    }
    if (sec.del || nw === '/dev/null') {
      if (old === null) continue;
      const p = old;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (old !== null && nw !== null && old !== nw) {
      edits.push((tree) => {
        if (!safe(old)) throw new Fail('unsafe', old);
        if (!safe(nw)) throw new Fail('unsafe', nw);
        const before = tree.get(old);
        if (before === null) throw new Fail('missing', old);
        if (tree.get(nw) !== null) throw new Fail('exists', nw);
        const st = fileState(before);
        applyHunks(st, sec.hunks, old, strict);
        tree.now.set(old, null);
        tree.now.set(nw, fileText(st));
        tree.moves.push([old, nw]);
      });
      continue;
    }
    const p = old ?? nw;
    if (p === null || p === '/dev/null') continue;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      const st = fileState(tree.get(p)!);
      applyHunks(st, sec.hunks, p, strict);
      tree.now.set(p, fileText(st));
    });
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  items: { t: 'ctx' | 'old' | 'new'; s: string }[];
  eof: boolean;
}

function applyV4aChunk(st: { lines: string[]; br: string; final: boolean }, ch: VChunk, path: string, strict: boolean, cursor: number): number {
  let cur = cursor;
  const tiers = strict ? [0] : [0, 1, 2];
  if (ch.anchor !== null && ch.anchor !== '') {
    let idx = -1;
    for (const tier of tiers) {
      const norm = tierNormalizer(tier);
      const a = norm(ch.anchor);
      for (let j = cur; j < st.lines.length; j += 1) {
        if (norm(st.lines[j]!) === a) { idx = j; break; }
      }
      if (idx >= 0) break;
    }
    if (idx < 0) throw new Fail('no-match', path);
    cur = idx + 1;
  }
  const O = ch.items.filter((it) => it.t !== 'new').map((it) => ({ t: it.t as 'ctx' | 'old', s: it.s }) as Piece);
  const N = ch.items.filter((it) => it.t !== 'old').map((it) => ({ t: it.t as 'ctx' | 'new', s: it.s }) as Piece);
  if (O.length === 0) {
    const pos = ch.eof ? st.lines.length : Math.min(cur, st.lines.length);
    st.lines.splice(pos, 0, ...N.map((it) => it.s));
    return pos + N.length;
  }
  let at = -1;
  let tier = 0;
  for (const t of tiers) {
    const norm = tierNormalizer(t);
    const o = O.map((x) => norm(x.s));
    for (let p = cur; p + O.length <= st.lines.length; p += 1) {
      if (ch.eof && p + O.length !== st.lines.length) continue;
      let hit = true;
      for (let j = 0; j < o.length; j += 1) if (norm(st.lines[p + j]!) !== o[j]) { hit = false; break; }
      if (hit) { at = p; tier = t; break; }
    }
    if (at >= 0) break;
  }
  if (at < 0) throw new Fail('no-match', path);
  const seg = bodySegment(st.lines, at, ch.items, tier);
  st.lines.splice(at, O.length, ...seg);
  return at + N.length;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new ParseExit(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (!isBlank(lines[i]!)) { last = i; break; }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseExit(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSecStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const secEnd = (i: number): number => {
    let e = i;
    while (e < last && !isSecStart(lines[e]!)) e += 1;
    return e;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) { i += 1; continue; }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      const end = secEnd(i + 1);
      let e = end;
      while (e > i + 1 && isBlank(lines[e - 1]!)) e -= 1;
      const content: string[] = [];
      for (let k = i + 1; k < e; k += 1) {
        const c = lines[k]!;
        if (c.startsWith('+')) content.push(c.slice(1));
        else if (isBlank(c)) content.push('');
        else throw new ParseExit(`error: parse ${k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : `${content.join('\n')}\n`);
      });
      i = end;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      const end = secEnd(i + 1);
      for (let k = i + 1; k < end; k += 1) if (!isBlank(lines[k]!)) throw new ParseExit(`error: parse ${k + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = end;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice(17).trim();
      const end = secEnd(i + 1);
      let e = end;
      while (e > i + 1 && isBlank(lines[e - 1]!)) e -= 1;
      const body: string[] = lines.slice(i + 1, e);
      let b = 0;
      while (b < body.length && isBlank(body[b]!)) b += 1;
      let moveTo: string | null = null;
      if (b < body.length && body[b]!.startsWith('*** Move to: ')) { moveTo = body[b]!.slice(13).trim(); b += 1; }
      const chunks: VChunk[] = [];
      let k = b;
      while (k < body.length) {
        const c = body[k]!;
        let anchor: string | null = null;
        if (c.startsWith('@@')) { anchor = c.slice(2).trim(); k += 1; }
        else if (chunks.length === 0) anchor = '';
        else throw new ParseExit(`error: parse ${i + 2 + k}`);
        const items: VChunk['items'] = [];
        let eof = false;
        while (k < body.length) {
          const c2 = body[k]!;
          if (c2 === '*** End of File') { eof = true; k += 1; break; }
          if (c2.startsWith('@@')) break;
          if (c2.startsWith('*** ')) throw new ParseExit(`error: parse ${i + 2 + k}`);
          if (c2.startsWith(' ')) items.push({ t: 'ctx', s: c2.slice(1) });
          else if (c2.startsWith('-')) items.push({ t: 'old', s: c2.slice(1) });
          else if (c2.startsWith('+')) items.push({ t: 'new', s: c2.slice(1) });
          else if (c2 === '') items.push({ t: 'ctx', s: '' });
          else throw new ParseExit(`error: parse ${i + 2 + k}`);
          k += 1;
        }
        chunks.push({ anchor, items, eof });
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseExit(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const st = fileState(before);
        let cursor = 0;
        for (const ch of chunks) cursor = applyV4aChunk(st, ch, p, strict, cursor);
        const after = fileText(st);
        if (moveTo !== null) {
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
          tree.now.set(p, null);
          tree.now.set(moveTo, after);
          tree.moves.push([p, moveTo]);
        } else tree.now.set(p, after);
      });
      i = end;
      continue;
    }
    throw new ParseExit(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && SUPPORTED_FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new ParseExit('error: parse 1');
  } catch (e) {
    if (e instanceof ParseExit) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [o, nw] of tree.moves) {
    if (rows.get(o) === `D ${o}` && rows.get(nw) === `A ${nw}`) {
      rows.delete(o);
      rows.set(nw, `R ${o} -> ${nw}`);
    }
  }
  const out: string[] = [];
  for (const p of [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const row = rows.get(p)!;
    out.push(row);
    if (check) continue;
    if (row.startsWith('R ')) {
      const [o, nw] = [row.slice(2, row.indexOf(' -> ')), row.slice(row.indexOf(' -> ') + 4)];
      rmSync(o, { force: true });
      mkdirSync(dirname(nw), { recursive: true });
      writeFileSync(nw, tree.now.get(p)!);
    } else {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  out.push(`ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
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
