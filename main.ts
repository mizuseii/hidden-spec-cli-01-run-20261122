// main.ts is mend, the CLI SPEC.md specifies (MIT, kit starter + sections 5-8).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
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

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [oldPath, newPath], for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/** A file's lines, its line break and whether it ends with one (SPEC section 3). */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

/* ---- Section 5: matching lines at three tiers ---- */

const stripLead = (s: string): string => s.replace(/^[ \t]+/, '');
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripLead(stripTrail(a)) === stripLead(stripTrail(b));
}

/** All 0-based positions where O occurs in the file's lines at this tier (overlaps allowed). */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences; null when none. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type LKind = 'ctx' | 'old' | 'new';
interface HLine {
  text: string;
  kind: LKind;
}
/** A hunk/chunk: O is its context + old lines, N its context + new lines. */
interface Hunk {
  o: HLine[];
  n: HLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  /** A `\` line follows the hunk's last `+` line (for created files). */
  lastPlusNoNL: boolean;
}

/**
 * The lines of N as they are written for a match at `pos` at `tier` (SPEC section 5):
 * a context line is the file's own matched line; at tier 2 every other line is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function writeN(o: HLine[], n: HLine[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  for (let i = 0; i < o.length; i++) if (o[i]!.kind === 'ctx') oCtx.push(i);
  let seenCtx = 0;
  const F = tier === 2 ? leadingWs(fileLines[pos] ?? '') : '';
  const P = tier === 2 && o.length > 0 ? leadingWs(o[0]!.text) : '';
  const out: string[] = [];
  for (const l of n) {
    if (l.kind === 'ctx') {
      const oi = oCtx[seenCtx];
      seenCtx++;
      out.push(oi === undefined ? l.text : (fileLines[pos + oi] ?? l.text));
    } else {
      let t = l.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** Build a Hunk from raw body lines (each starting with ' ', '-', '+', '\', or empty). */
function buildHunk(body: string[]): Hunk {
  type Item = { text: string; kind: LKind | 'bs' };
  const items: Item[] = [];
  for (const l of body) {
    if (l === '') items.push({ text: '', kind: 'ctx' });
    else if (l[0] === ' ') items.push({ text: l.slice(1), kind: 'ctx' });
    else if (l[0] === '-') items.push({ text: l.slice(1), kind: 'old' });
    else if (l[0] === '+') items.push({ text: l.slice(1), kind: 'new' });
    else items.push({ text: l, kind: 'bs' });
  }
  const lastIdx = (kinds: Array<LKind | 'bs'>): number => {
    for (let k = items.length - 1; k >= 0; k--) if (kinds.includes(items[k]!.kind)) return k;
    return -1;
  };
  const lastCtxOrNew = lastIdx(['ctx', 'new']);
  const noNL = lastCtxOrNew >= 0 && lastCtxOrNew + 1 < items.length && items[lastCtxOrNew + 1]!.kind === 'bs';
  const lastPlus = lastIdx(['new']);
  const lastPlusNoNL = lastPlus >= 0 && lastPlus + 1 < items.length && items[lastPlus + 1]!.kind === 'bs';
  const o = items.filter((x) => x.kind === 'ctx' || x.kind === 'old').map((x) => ({ text: x.text, kind: x.kind as LKind }));
  const n = items.filter((x) => x.kind === 'ctx' || x.kind === 'new').map((x) => ({ text: x.text, kind: x.kind as LKind }));
  return { o, n, noNL, lastPlusNoNL };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- Section 6: unified diffs ---- */

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: { A: number; hunk: Hunk }[];
}

/** Path from a `--- `/`+++ ` line: text after the four chars, up to the first tab, trimmed; a/ or b/ stripped; /dev/null is no file. */
function cleanUnifiedPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** Path from a `rename from`/`rename to` line: up to the first tab, trimmed; /dev/null is no file. */
function cleanRenamePath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let hasPair = false;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let plusNew: string | null = null;
  let gitOld: string | null = null;
  let gitNew: string | null = null;

  const finishSection = (): void => {
    if (cur === null) return;
    cur.oldPath = pairOld ?? renameFrom ?? gitOld;
    cur.newPath = pairNew ?? renameTo ?? plusNew ?? gitNew;
    sections.push(cur);
    cur = null;
    inHeader = false;
    hasPair = false;
    pairOld = null;
    pairNew = null;
    renameFrom = null;
    renameTo = null;
    plusNew = null;
    gitOld = null;
    gitNew = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      gitOld = m[1]!;
      gitNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        pairOld = cleanUnifiedPath(line.slice(4));
        pairNew = cleanUnifiedPath(next.slice(4));
        hasPair = true;
        i += 2;
        continue;
      }
      finishSection();
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      pairOld = cleanUnifiedPath(line.slice(4));
      pairNew = cleanUnifiedPath(next.slice(4));
      hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ A: Number(m[1]), hunk: buildHunk(body) });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ') && !hasPair && plusNew === null) {
        plusNew = cleanUnifiedPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ') && !hasPair && renameFrom === null) {
        renameFrom = cleanRenamePath(line.slice(12));
        i++;
        continue;
      }
      if (line.startsWith('rename to ') && !hasPair && renameTo === null) {
        renameTo = cleanRenamePath(line.slice(10));
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishSection();
  return sections;
}

/** Apply one unified hunk to a file's parts; `path` is the file the failure concerns. */
function applyUnifiedHunk(parts: FileParts, hunk: Hunk, A: number, d: number, strict: boolean, path: string): FileParts {
  const oTexts = hunk.o.map((l) => l.text);
  if (oTexts.length === 0) {
    let at = A + d;
    if (at < 0) at = 0;
    if (at > parts.lines.length) at = parts.lines.length;
    const ins = hunk.n.map((l) => l.text);
    const lines = [...parts.lines.slice(0, at), ...ins, ...parts.lines.slice(at)];
    const final = at === parts.lines.length ? !hunk.noNL : parts.final;
    return { lines, br: parts.br, final };
  }
  const found = findTier(parts.lines, oTexts, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = A - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const written = writeN(hunk.o, hunk.n, parts.lines, best, found.tier);
  const lines = [...parts.lines.slice(0, best), ...written, ...parts.lines.slice(best + oTexts.length)];
  const final = best + oTexts.length === parts.lines.length ? !hunk.noNL : parts.final;
  return { lines, br: parts.br, final };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let createNoNL = false;
      for (const { hunk } of sec.hunks) {
        if (hunk.n.some((l) => l.kind === 'new')) createNoNL = hunk.lastPlusNoNL;
        for (const l of hunk.n) if (l.kind === 'new') plus.push(l.text);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (createNoNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let parts = fileParts(tree.get(oldP)!);
      let d = 0;
      for (const { A, hunk } of sec.hunks) {
        parts = applyUnifiedHunk(parts, hunk, A, d, strict, oldP);
        d += hunk.n.length - hunk.o.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(parts));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      let parts = fileParts(tree.get(oldP)!);
      let d = 0;
      for (const { A, hunk } of sec.hunks) {
        parts = applyUnifiedHunk(parts, hunk, A, d, strict, oldP);
        d += hunk.n.length - hunk.o.length;
      }
      tree.now.set(oldP, joinFile(parts));
      return;
    }
    // Both paths /dev/null: nothing to do.
  };
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = prevPath;
      }
      let k = i + 1;
      let sep = -1;
      while (k < lines.length) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') {
          sep = k;
          break;
        }
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
        k++;
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let m = sep + 1;
      let end = -1;
      while (m < lines.length) {
        const t = lines[m]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          end = m;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
        m++;
      }
      if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

function srEdit(block: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const parts = fileParts(cur);
    const found = findTier(parts.lines, block.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const o: HLine[] = block.oldLines.map((text) => ({ text, kind: 'old' as LKind }));
    const n: HLine[] = block.newLines.map((text) => ({ text, kind: 'new' as LKind }));
    const written = writeN(o, n, parts.lines, pos, found.tier);
    const lines = [...parts.lines.slice(0, pos), ...written, ...parts.lines.slice(pos + block.oldLines.length)];
    tree.now.set(p, joinFile({ lines, br: parts.br, final: parts.final }));
  };
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  o: HLine[];
  n: HLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  headerLine: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const headerOf = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = headerOf(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const headerLine = i + 1;
    const raw: { text: string; lineNo: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (!blank(l) && headerOf(l) !== null) break;
      raw.push({ text: l, lineNo: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text[0] === '+') fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fileLines, chunks: [], headerLine });
    } else if (kind === 'delete') {
      for (const r of raw) throw new Exit2(`error: parse ${r.lineNo}`);
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], headerLine });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let curChunk: { anchor: string | null; body: HLine[]; eof: boolean } | null = null;
      const pushChunk = (): void => {
        if (curChunk === null) return;
        const o = curChunk.body.filter((x) => x.kind === 'ctx' || x.kind === 'old');
        const n = curChunk.body.filter((x) => x.kind === 'ctx' || x.kind === 'new');
        chunks.push({ anchor: curChunk.anchor, o, n, eof: curChunk.eof });
        curChunk = null;
      };
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          pushChunk();
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        } else if (l.trim() === '*** End of File') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          curChunk.eof = true;
          pushChunk();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          if (l === '') curChunk.body.push({ text: '', kind: 'ctx' });
          else if (l[0] === ' ') curChunk.body.push({ text: l.slice(1), kind: 'ctx' });
          else if (l[0] === '-') curChunk.body.push({ text: l.slice(1), kind: 'old' });
          else curChunk.body.push({ text: l.slice(1), kind: 'new' });
        } else {
          throw new Exit2(`error: parse ${r.lineNo}`);
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, headerLine });
    }
    i = j;
  }
  return sections;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let parts = fileParts(cur);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let x = cursor; x < parts.lines.length; x++) {
            if (lineEq(parts.lines[x]!, chunk.anchor, t)) {
              foundIdx = x;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', sec.path);
        cursor = foundIdx + 1;
      }
      const oTexts = chunk.o.map((l) => l.text);
      if (oTexts.length === 0) {
        const at = chunk.eof ? parts.lines.length : cursor;
        const ins = chunk.n.map((l) => l.text);
        const lines = [...parts.lines.slice(0, at), ...ins, ...parts.lines.slice(at)];
        parts = { lines, br: parts.br, final: parts.final };
        cursor = at + ins.length;
      } else {
        let chosen: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(parts.lines, oTexts, t).filter(
            (p) => p >= cursor && (!chunk.eof || p + oTexts.length === parts.lines.length),
          );
          if (occ.length > 0) {
            chosen = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (chosen === null) throw new Fail('no-match', sec.path);
        const written = writeN(chunk.o, chunk.n, parts.lines, chosen.pos, chosen.tier);
        const lines = [...parts.lines.slice(0, chosen.pos), ...written, ...parts.lines.slice(chosen.pos + oTexts.length)];
        parts = { lines, br: parts.br, final: parts.final };
        cursor = chosen.pos + written.length;
      }
    }
    const text = joinFile(parts);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

/* ---- Section 9: JSON edits (starter) ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
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
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
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
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows = new Map<string, { key: string; text: string }>();
  for (const [p, { was, now }] of changed) {
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const oldRow = rows.get(oldP);
    const newRow = rows.get(newP);
    if (oldRow !== undefined && newRow !== undefined && oldRow.text.startsWith('D ') && newRow.text.startsWith('A ')) {
      rows.delete(oldP);
      rows.delete(newP);
      rows.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, { now }] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...sorted.map((r) => r.text), `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`] };
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
