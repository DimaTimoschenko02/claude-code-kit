// Quote-aware reading of a Bash command — the JS twin of shell_text.py (scan and OPENER only; strip/shell_fed are not
// ported, no JS caller needs them yet). Pure ESM, no Node API: it is also copied into a Claude Code mod.
//
// The Python helpers it twins use `re`, `str.strip/split` and `shlex`, whose semantics differ from JS in small ways that
// change answers: Python's \w, \d, \s and \b are Unicode, `$` also matches before a final newline, `.` stops only at \n,
// str.isspace() counts \x1c-\x1f and \x85 but not ﻿. PyRe compiles a Python pattern into a JS RegExp with those
// semantics, so a pattern is copied from the .py source as is and both engines print the same paths.

const SYNTAX = String.raw`^$\.*+?()[]{}|/-`; // escapes a JS `u` RegExp accepts as identity escapes
/** Python's \w, \d, \s as JS class bodies: for any subject (`unicode`), or for one that is all ASCII — there the two
 * agree, and an ASCII class compiles ~20x faster than `\p{L}\p{N}`: on a cold hook process compiling the Unicode
 * classes was ~90% of a call (50–100 ms for a large python heredoc). */
function classes(unicode) {
  const w = unicode ? String.raw`\p{L}\p{N}_` : 'A-Za-z0-9_'; // str \w: isalnum() or _
  const d = unicode ? String.raw`\p{Nd}` : '0-9';
  const s = String.raw`\t\n\v\f\r\x1c-\x20` + (unicode ? String.raw`\x85\xa0  -     　` : ''); // str.isspace()
  return {
    in: { w, d, s },
    out: { w: `[${w}]`, W: `[^${w}]`, d: `[${d}]`, D: `[^${d}]`, s: `[${s}]`, S: `[^${s}]`, b: `(?:(?<=[${w}])(?![${w}])|(?<![${w}])(?=[${w}]))` },
  };
}
const CLASSES = [classes(false), classes(true)];
const NON_ASCII = /[^\x00-\x7f]/;
const SPACE = new RegExp(`[${CLASSES[1].in.s}]`, 'u');

/** A Python `re` pattern as JS RegExp source with Python's semantics; `dotAll` = re.S; `unicode` = see classes(). */
function translate(src, dotAll, unicode) {
  const { in: CLASS_IN, out: CLASS_OUT } = CLASSES[unicode ? 1 : 0];
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[++i];
      const known = inClass ? CLASS_IN[n] : CLASS_OUT[n];
      if (known) out += known;
      else if (/[A-Za-z0-9]/.test(n) || SYNTAX.includes(n)) out += `\\${n}`;
      else out += n; // `\"`, `\'`: a SyntaxError under the `u` flag, the plain char means the same
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
    } else if (c === '[') {
      inClass = true;
      out += c;
      if (src[i + 1] === '^') out += src[++i];
      if (src[i + 1] === ']') { // Python: a `]` first in a class is literal
        out += '\\]';
        i += 1;
      }
    } else if (c === '$') out += String.raw`(?=\n?(?![\s\S]))`;
    else if (c === '.') out += dotAll ? String.raw`[\s\S]` : String.raw`[^\n]`;
    else if (src.startsWith('(?P<', i)) {
      out += '(?<';
      i += 3;
    } else out += c;
  }
  return out;
}

/** A compiled Python pattern with re's call shapes. Matches are JS match arrays; `start(m)`/`end(m)` give the span. */
export class PyRe {
  // Each RegExp is built on first use, in the ASCII or the Unicode flavour the subject needs: a hook process answers
  // one command, and building every variant of every pattern up front was most of the import time.
  constructor(src, { dotAll = false, indices = false } = {}) {
    this.src = src;
    this.dotAll = dotAll;
    this.flags = indices ? 'ud' : 'u';
    this.built = [{}, {}]; // [ascii, unicode]: { js, g, y, full }
  }

  /** The RegExp of `kind` (g = search/finditer, y = match, full = fullmatch) for subject s. */
  rx(kind, s) {
    const unicode = NON_ASCII.test(s);
    const b = this.built[unicode ? 1 : 0];
    if (!b[kind]) {
      b.js ??= translate(this.src, this.dotAll, unicode);
      b[kind] = kind === 'full' ? new RegExp(`^(?:${b.js})$`, this.flags) : new RegExp(b.js, kind + this.flags);
    }
    return b[kind];
  }

  search(s, pos = 0) {
    const g = this.rx('g', s);
    g.lastIndex = pos;
    return g.exec(s);
  }

  match(s, pos = 0) {
    const y = this.rx('y', s);
    y.lastIndex = pos;
    return y.exec(s);
  }

  fullmatch(s) {
    return this.rx('full', s).exec(s);
  }

  finditer(s) {
    const g = this.rx('g', s);
    g.lastIndex = 0; // matchAll starts where the last search() left this regex
    return [...s.matchAll(g)];
  }

  /** re.findall: the whole match without groups, group 1 with one, every group ('' when unset) with more. */
  findall(s) {
    return this.finditer(s).map((m) => (m.length === 1 ? m[0] : m.length === 2 ? (m[1] ?? '') : m.slice(1).map((g) => g ?? '')));
  }

  /** re.sub with a function or a literal replacement. */
  sub(s, repl) {
    let out = '';
    let at = 0;
    for (const m of this.finditer(s)) {
      out += s.slice(at, m.index) + (typeof repl === 'function' ? repl(m) : repl);
      at = m.index + m[0].length;
    }
    return out + s.slice(at);
  }
}

export const end = (m) => m.index + m[0].length;
export const isSpace = (c) => SPACE.test(c);

/** str.strip(): Python's whitespace, or the given characters. */
export function pyStrip(s, chars = null) {
  const keep = chars === null ? (c) => !isSpace(c) : (c) => !chars.includes(c);
  let a = 0;
  let b = s.length;
  while (a < b && !keep(s[a])) a++;
  while (b > a && !keep(s[b - 1])) b--;
  return s.slice(a, b);
}

/** str.split(sep): runs of Python whitespace when sep is null; '' raises like Python. */
export function pySplit(s, sep = null) {
  if (sep === '') throw new Error('ValueError: empty separator');
  if (sep !== null) return s.split(sep);
  const out = [];
  let word = '';
  for (const c of s) {
    if (isSpace(c)) {
      if (word) out.push(word);
      word = '';
    } else word += c;
  }
  if (word) out.push(word);
  return out;
}

/** shlex.split(s, comments=False, posix=True); throws on an unclosed quote or a trailing escape, as shlex does. */
export function shlexSplit(s) {
  const WHITE = ' \t\r\n';
  const out = [];
  let state = ' ';
  let token = '';
  let quoted = false;
  let escaped = ' ';
  const emit = () => {
    if (token || quoted) out.push(token);
    token = '';
    quoted = false;
  };
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : '';
    if (state === ' ' || state === 'a') {
      if (!c) break;
      if (WHITE.includes(c)) {
        if (state === 'a' || token || quoted) emit();
        state = ' ';
      } else if (c === '\\') {
        escaped = 'a';
        state = '\\';
      } else if (c === "'" || c === '"') state = c;
      else {
        token += c;
        state = 'a';
      }
    } else if (state === "'" || state === '"') {
      quoted = true;
      if (!c) throw new Error('ValueError: No closing quotation');
      if (c === state) state = 'a';
      else if (c === '\\' && state === '"') {
        escaped = state;
        state = '\\';
      } else token += c;
    } else {
      if (!c) throw new Error('ValueError: No escaped character');
      if ((escaped === "'" || escaped === '"') && c !== '\\' && c !== escaped) token += '\\';
      token += c;
      state = escaped;
    }
  }
  if (token || quoted) out.push(token);
  return out;
}

export const OPENER = new PyRe(String.raw`<<-?\s*\\?(['\"]?)([A-Za-z_]\w*)\1`);

/**
 * scan(cmd) -> [raw, mask, bodies], as shell_text.scan: raw = the command without heredoc bodies and `# comments`;
 * mask = raw with quoted characters as `x` (same length); bodies = heredoc bodies in opener order.
 */
export function scan(cmd) {
  const lines = cmd.split('\n');
  const raw = [];
  const mask = [];
  const bodies = [];
  let quote = null;
  let subst = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const r = line.split('');
    const m = line.split('');
    const pending = [];
    let k = 0;
    while (k < line.length) {
      const ch = line[k];
      if (quote) {
        if (quote === '"' && ch === '\\' && k + 1 < line.length) {
          m[k] = m[k + 1] = 'x';
          k += 2;
          continue;
        }
        if (quote === '"' && line.startsWith('$(', k)) subst += 1;
        else if (quote === '"' && ch === ')' && subst) subst -= 1;
        else if (quote === '"' && subst && line.startsWith('<<<', k)) {
          m[k] = m[k + 1] = m[k + 2] = 'x';
          k += 3;
          continue;
        } else if (quote === '"' && subst && ch === '<') {
          const found = OPENER.match(line, k);
          if (found) {
            pending.push(found[2]);
            k = end(found);
            continue;
          }
        }
        if (ch === quote) quote = null;
        else m[k] = 'x';
        k += 1;
      } else if (ch === '\\') k += 2;
      else if (ch === '"' || ch === "'") {
        quote = ch;
        subst = 0;
        k += 1;
      } else if (ch === '#' && (k === 0 || ' \t;&|('.includes(line[k - 1]))) {
        for (let j = k; j < line.length; j++) r[j] = m[j] = ' ';
        break;
      } else if (line.startsWith('<<<', k)) {
        m[k] = m[k + 1] = m[k + 2] = ' ';
        k += 3;
      } else if (ch === '<' && OPENER.match(line, k)) {
        const found = OPENER.match(line, k);
        pending.push(found[2]);
        k = end(found);
      } else k += 1;
    }
    raw.push(r.join(''));
    mask.push(m.join(''));
    i += 1;
    for (const tag of pending) {
      const body = [];
      while (i < lines.length && pyStrip(lines[i]) !== tag) body.push(lines[i++]);
      i += 1;
      bodies.push(body.join('\n'));
    }
    if (quote && i < lines.length) mask[mask.length - 1] += '\0';
  }
  const rawText = raw.join('\n');
  const maskText = mask.map((part) => (part.endsWith('\0') ? `${part.slice(0, -1)}x` : `${part}\n`)).join('').slice(0, rawText.length);
  return [rawText, maskText, bodies];
}
