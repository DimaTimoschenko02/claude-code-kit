// The files a Bash command is likely to WRITE — the JS twin of bash-write-targets.py, same answer for the same input.
// Why a twin: a hook that starts `python3 bash-write-targets.py` per Bash call pays 0.3–0.9 s for the process alone on
// Windows; imported, this runs in the hook's own process. The heuristic, its reasons and its cases live in the .py
// docstring and test_bash_write_targets.py (BWT_IMPL=node runs every case here); a rule change lands in both files.
//
// Pure ESM, no Node API, no dynamic import: it is also copied into a Claude Code mod. Paths are joined by hand with the
// .py's rules: `/` joins, a path is absolute when it starts with `/` or a drive (`C:/`, `C:\`), a drive path is printed
// with `/`, `/c/x` (Git Bash) stays as is.
//
//   bashWriteTargets(command, cwd, { env, home }) -> string[]
//   env  — answers `$VAR` the command does not assign itself; the .py reads os.environ (pass process.env: on Windows
//          its lookups ignore case, as os.environ's do).
//   home — what `~` and `~/…` expand to; the .py uses os.path.expanduser("~") (HOME, on Windows USERPROFILE).
//          '' leaves `~` as written. `~user` is never expanded.
// Throws where the .py crashes (a `'…'.split('')` loop source): a caller treats it as "no targets", as it treated the
// .py's non-zero exit.
import { OPENER, PyRe, end, pySplit, pyStrip, scan, shlexSplit } from './shell-text.mjs';

const INTERPRETERS = ['python', 'python3', 'node', 'perl', 'ruby'];
const SEG_WRITERS = new Set(['rm', 'mv', 'truncate']);
const DRIVE = /^[A-Za-z]:[\\/]/;
const R = String.raw;

/** A Windows drive path with `/` only: `C:\a\b` -> `C:/a/b`. Anything else unchanged. */
const respell = (p) => (DRIVE.test(p) ? p.replace(/\\/g, '/') : p);
const isAbs = (p) => p.startsWith('/') || DRIVE.test(p);
const basename = (p) => p.split(/[\\/]/).pop();

function join(a, ...rest) {
  for (const b of rest) {
    if (isAbs(b)) a = b;
    else if (!a || a.endsWith('/')) a += b;
    else a += `/${b}`;
  }
  return a;
}

/** posixpath.normpath, a drive kept in front. */
function normpath(p) {
  if (DRIVE.test(p)) return p.slice(0, 2) + normpath(p.slice(2));
  if (!p) return '.';
  let initial = p.startsWith('/') ? 1 : 0;
  if (p.startsWith('//') && !p.startsWith('///')) initial = 2;
  const comps = [];
  for (const comp of p.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initial && !comps.length) || (comps.length && comps[comps.length - 1] === '..')) comps.push(comp);
    else if (comps.length) comps.pop();
  }
  return '/'.repeat(initial) + comps.join('/') || '.';
}

function expandUser(s, home) {
  if (!home || (s !== '~' && !s.startsWith('~/'))) return s;
  return home.replace(/\/+$/, '') + s.slice(1) || '/';
}

// Interpreter heredoc bodies — heredocTargets(). In a statement's code string literal i stands as \x01i\x02.
const _L = R`\x01([0-9]+)\x02`;
const _PATH = R`(?:pathlib\.)?(?:Pure)?(?:Posix)?Path`;
const LIT = new PyRe(_L);
const BODY_WRITE = new PyRe(
  R`\.write\(|write_text\(|write_bytes\(|writeFileSync|appendFileSync|writeFile\(|appendFile\(|createWriteStream|`
  + R`os\.remove|os\.rename|os\.replace|shutil\.(move|copy|rmtree)|unlink|\brmSync|renameSync|copyFileSync|`
  + R`open(?:Sync)?\((?:[^()]|\([^()]*\))*['"](?:[wax]|r[bt]?\+|>>?)[bt+]*['"]`,
);
const MODE = new PyRe(R`[rwxabt+<>]{1,4}`);
const FILE_NAME = new PyRe(R`[^\s/'\"\\]+\.[A-Za-z][\w-]{0,9}`);
const DATA_ARGS = [
  [new PyRe(R`(?<!File)(?<!IO)\.write\(|\.writelines\(|write_text\(|write_bytes\(`), 'all'],
  [new PyRe(R`(?<![\w.$])(?:File|IO)\.write\(|(?:writeFile|appendFile)(?:Sync)?\(`), 'rest'],
  [new PyRe(R`(?<![\w.$])(?:json|yaml|pickle|toml)\.dump\(`), 'first'],
];
const FOLDS = [
  [new PyRe(R`(?<![\w.$])${_PATH}\.home\(\s*\)|(?<![\w.$])os\.homedir\(\s*\)`), () => '~'],
  [new PyRe(R`(?<![\w.$])(?:${_PATH}\.cwd|os\.getcwd|process\.cwd)\(\s*\)`), () => '.'],
  [new PyRe(R`(?<![\w.$])(?:${_PATH}|os\.path\.(?:expanduser|abspath|realpath|normpath)|os\.fspath|str|String)`
    + R`\(\s*${_L}\s*\)|${_L}\.(?:expanduser|resolve|absolute)\(\s*\)`), (v) => v[0]],
  [new PyRe(R`(?<![\w.$])(?:${_PATH}|os\.path\.join|posixpath\.join|path\.resolve|(?P<js>path\.join))`
    + R`\(\s*${_L}(?:\s*,\s*${_L})*\s*,?\s*\)`), null], // join: node's path.join only concatenates
  [new PyRe(R`${_L}\s*/\s*${_L}`), (v) => join(...v)], // pathlib's `/`
  [new PyRe(R`${_L}\s*\+\s*${_L}`), (v) => v.join('')],
  [new PyRe(R`(?<![\w$\])])\(\s*${_L}\s*\)`), (v) => v[0]],
];
const PATH_CALL = new PyRe(R`(?<![\w.$])(?:(?:os\.)?path\.\w+|posixpath\.\w+|${_PATH}|os\.fspath|str|String)\s*\(`);
const ASSIGN = new PyRe(R`\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w.]+\s*)?=(?!=)(.*)`, { dotAll: true });
const LOOP = new PyRe(R`\s*(?:async\s+)?for\s+(.+?)\s+in\s+(.*)`, { dotAll: true });
const DEF = new PyRe(R`\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`);
const WALK = new PyRe(R`(?<![\w$])(?:i?glob|rglob|iterdir|listdir|scandir|walk|readdirSync)\s*\(`);
const HEADER = new PyRe(R`\s*(?:async\s+)?(?:for|while|if|elif)\b`);
const ARGV = new PyRe(R`(?<![\w.$])(?:sys|process)\.argv\[([0-9]+)\]`);
const PREFIX = new PyRe(R`(?<![\w$])[rRbBuUfF]{1,2}$`);
const FOR_WORD = new PyRe(R`\bfor\b`);
const TAIL_NAME = new PyRe(R`[\w$.]*$`);
const AS_NAME = new PyRe(R`\bas\s+[\w$]+`);
const NAME = new PyRe(R`(?<![\w$.])[A-Za-z_$][\w$]*`);
const PARAM = new PyRe(R`\s*\**(\w*)`);
const KEYWORD_ARG = new PyRe(R`\s*\w+\s*=(?!=)`);
const NAMED_SOURCE = new PyRe(R`([A-Za-z_]\w*)(?:\.(items|keys|values)\(\s*\))?`);
const SPLIT_SOURCE = new PyRe(R`\s*${_L}\.split(?:lines)?\(\s*(?:${_L})?\s*\)\s*`);
const SHELL_ENV = new PyRe(R`(?:^|[\s;&|(])([A-Za-z_]\w*)=(\"[^\"]*\"|'[^']*'|[^\s;&|]+)`);
const VAR = new PyRe(R`\$\{(\w+)\}|\$(\w+)`);
const SEPARATOR = new PyRe(R`\n|;|&&|\|\||\|`);
const LEAD = new PyRe(R`[\s(]*`);
const TRAIL = new PyRe(R`[\s)]*$`);
const REDIRECT = new PyRe(R`(\d?)>>?\s*(\"[^\"]+\"|'[^']+'|[^\s;&|<>]+)`, { indices: true });
const ASSIGN_WORD = new PyRe(R`^[A-Za-z_]\w*=`);
const OPEN = '([{';
const CLOSE = ')]}';
const lit = (i) => `\x01${i}\x02`;
const escapeName = (name) => name.replace(/\$/g, '\\$'); // re.escape of `[A-Za-z_$][\w$]*`

/** An interpreter heredoc body as statements [code, wcode, lits] — see statements() in the .py. */
function statements(body, js) {
  const out = [];
  let code = [];
  let wcode = [];
  let lits = [];
  const stack = [];
  const n = body.length;
  const put = (c, w = c) => {
    code.push(c);
    wcode.push(w);
  };
  const cut = () => {
    const text = code.join('');
    if (pyStrip(text)) out.push([text, wcode.join(''), lits.slice()]);
    code = [];
    wcode = [];
    lits = [];
  };
  let i = 0;
  while (i < n) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || (js && ch === '`')) {
      const three = body.slice(i, i + 3);
      const q = !js && (three === "'''" || three === '"""') ? three : ch;
      let j = i + q.length;
      while (j < n && !body.startsWith(q, j) && !((ch === "'" || ch === '"') && q.length === 1 && body[j] === '\n')) {
        j += body[j] === '\\' ? 2 : 1;
      }
      const text = body.slice(i + q.length, j);
      j = body.startsWith(q, j) ? j + q.length : j; // an unclosed quote ends at its line
      const prefix = js ? null : PREFIX.search(code.slice(-3).join(''));
      if (prefix) { // f'…', rb'…': the prefix is part of the literal
        const keep = Math.max(code.length - prefix[0].length, 0);
        code.length = keep;
        wcode.length = Math.max(wcode.length - prefix[0].length, 0);
      }
      put(lit(lits.length), MODE.fullmatch(text) ? body.slice(i, j) : ch + ch);
      lits.push(text);
      i = j;
    } else if ((js && body.startsWith('//', i)) || (!js && ch === '#')) {
      const stop = body.indexOf('\n', i);
      i = stop < 0 ? n : stop;
    } else if (js && body.startsWith('/*', i)) {
      const stop = body.indexOf('*/', i + 2);
      i = stop < 0 ? n : stop + 2;
    } else if (ch === '\\' && body.startsWith('\n', i + 1)) {
      put(' ');
      i += 2;
    } else if ((ch === '\n' || ch === ';') && (!stack.length || (js && stack[stack.length - 1] === '{'))) {
      cut();
      i += 1;
    } else {
      if (OPEN.includes(ch)) stack.push(ch);
      else if (CLOSE.includes(ch) && stack.length) stack.pop();
      put(ch);
      i += 1;
    }
  }
  cut();
  return out;
}

/** code with each literal-only path expression (FOLDS) and each `sys.argv[N]` folded into one new literal. */
function fold(code, lits, js, argv) {
  lits = lits.slice();
  const add = (value) => {
    lits.push(value);
    return lit(lits.length - 1);
  };
  code = ARGV.sub(code, (m) => (Number(m[1]) < argv.length ? add(argv[Number(m[1])]) : m[0]));
  for (let round = 0; round < 100; round++) {
    let folded = false;
    for (const [rx, value] of FOLDS) {
      const m = rx.search(code);
      if (!m) continue;
      const v = LIT.findall(m[0]).map((x) => lits[Number(x)]);
      const path = value === null ? (js && m.groups?.js !== undefined ? v.join('/') : join(...v)) : value(v);
      code = code.slice(0, m.index) + add(path) + code.slice(end(m));
      folded = true;
      break;
    }
    if (!folded) break;
  }
  return [code, lits];
}

/** Index of the bracket that closes the call whose arguments start at `at`. */
function argsEnd(code, at) {
  let depth = 0;
  while (at < code.length && !(CLOSE.includes(code[at]) && depth === 0)) {
    depth += (OPEN.includes(code[at]) ? 1 : 0) - (CLOSE.includes(code[at]) ? 1 : 0);
    at += 1;
  }
  return at;
}

/** text cut at `sep` outside brackets. */
function splitTop(text, sep = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    depth += (OPEN.includes(ch) ? 1 : 0) - (CLOSE.includes(ch) ? 1 : 0);
    if (ch === sep && depth === 0) {
      parts.push(text.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A list, set, dict or generator comprehension: a `for` right inside its outer brackets. */
function comprehension(code) {
  code = pyStrip(code);
  if (!['[', '(', '{'].includes(code.slice(0, 1)) || argsEnd(code, 1) !== code.length - 1) return false;
  let top = '';
  let depth = 0;
  for (const ch of code.slice(1, -1).split('')) {
    depth -= CLOSE.includes(ch) ? 1 : 0;
    top += depth === 0 ? ch : ' ';
    depth += OPEN.includes(ch) ? 1 : 0;
  }
  return FOR_WORD.search(top) !== null;
}

/** The part of a write statement that says where it writes: DATA_ARGS blanked. */
function withoutData(code) {
  const out = code.split('');
  for (const [rx, kind] of DATA_ARGS) {
    for (const m of rx.finditer(code)) {
      const after = end(m);
      const close = argsEnd(code, after);
      const first = splitTop(code.slice(after, close))[0].length;
      let [start, stop] = kind === 'all' ? [after, close] : kind === 'rest' ? [after + first + 1, close] : [after, after + first];
      if (kind === 'all' && code[m.index] === '.') start = TAIL_NAME.search(code.slice(0, m.index)).index;
      for (let k = start; k < stop; k++) out[k] = ' ';
    }
  }
  return out.join('');
}

/** A one-line compound statement's body, its header blanked — see header_body() in the .py. */
function headerBody(code, wcode) {
  const parts = HEADER.match(code) ? splitTop(code, ':') : [];
  if (parts.length < 2 || BODY_WRITE.search(splitTop(wcode, ':')[0])) return code;
  const head = parts[0].length + 1;
  return ' '.repeat(head) + code.slice(head);
}

/** The literals in a piece of folded code that are paths: they hold a `/` or are a FILE_NAME. */
function pathValues(code, lits) {
  return LIT.findall(code).map((x) => lits[Number(x)])
    .filter((p) => (p.includes('/') || FILE_NAME.fullmatch(p)) && !p.includes('\n'));
}

/** The names a piece of code reads: not attributes, not path calls, not the `as f` of `with open(…) as f`. */
function namesIn(code) {
  code = AS_NAME.sub(PATH_CALL.sub(LIT.sub(code, ' '), '('), ' ');
  return new Set(NAME.findall(code));
}

/** A literal list, tuple, dict, set or comprehension: values, not one path. */
function isData(rhs) {
  rhs = pyStrip(rhs);
  const inner = rhs.slice(0, 1) === '(' && argsEnd(rhs, 1) === rhs.length - 1 ? rhs.slice(1, -1) : null;
  return ['[', '{'].includes(rhs.slice(0, 1)) || splitTop(rhs).length > 1 || rhs.startsWith('lambda')
    || (inner !== null && splitTop(inner).length > 1) || comprehension(rhs);
}

/** Paths in the elements of a literal container a loop walks — see element_values() in the .py. */
function elementValues(container, lits, k, view) {
  const c = pyStrip(container);
  if (!['[', '(', '{'].includes(c.slice(0, 1)) || ![']', ')', '}'].includes(c.slice(-1)) || comprehension(c)) return null;
  const out = [];
  for (const el of splitTop(c.slice(1, -1))) {
    const entry = c[0] === '{' ? splitTop(el, ':') : [el];
    let part;
    if (entry.length === 2) {
      part = view === 'values' || (view === 'items' && k === 1) ? entry[1] : entry[0];
    } else {
      const e = pyStrip(el);
      const items = k !== null && '(['.includes(e.slice(0, 1)) && ')]'.includes(e.slice(-1)) ? splitTop(e.slice(1, -1)) : [e];
      part = k !== null && k < items.length ? items[k] : k === null ? items[0] : '';
    }
    out.push(...pathValues(part, lits));
  }
  return out;
}

/** stmts with every read of a name bound once, to one path literal, replaced by that literal and folded again. */
function constants(stmts, js, argv) {
  const text = stmts.map(([code]) => code).join('\n');
  const values = new Map();
  for (const [code, lits] of stmts) {
    const m = ASSIGN.match(code);
    if (!m) continue;
    const one = LIT.fullmatch(pyStrip(m[2]));
    if (!values.has(m[1])) values.set(m[1], []);
    values.get(m[1]).push(one && pathValues(one[0], lits).length ? lits[Number(one[1])] : null);
  }
  for (const [name, vals] of values) {
    const n = escapeName(name);
    const binds = new PyRe(R`(?<![\w.$])${n}\s*(?:[-+*/%|&^@]|//|\*\*|>>|<<)?=(?!=)`).finditer(text).length
      + new PyRe(R`(?<![\w.$])${n}\s*,[^=\n]*=(?!=)|\bfor\s[^\n]*?(?<![\w.$])${n}(?![\w$])[^\n]*?\s(?:in|of)\s|`
        + R`\b(?:as|def|function|catch|global|nonlocal|import)\b[^\n{:=]*?(?<![\w.$])${n}(?![\w$])|`
        + R`(?<![\w.$])${n}\s*(?:,[^()\n]*)?\)?\s*=>`).finditer(text).length;
    if (vals.length !== 1 || vals[0] === null || binds !== 1) continue;
    const read = new PyRe(R`(?<![\w.$])${n}(?![\w$])(?!\s*(?::\s*[\w.]+\s*)?=(?!=))`);
    stmts.forEach(([code, lits, wcode], i) => {
      if (!read.search(code)) return;
      const grown = [...lits, vals[0]];
      stmts[i] = [...fold(read.sub(code, lit(grown.length - 1)), grown, js, argv), wcode];
    });
  }
  return stmts;
}

/** Paths an interpreter heredoc writes — see heredoc_targets() in the .py. */
function heredocTargets(body, js, argv) {
  const stmts = constants(statements(body, js).map(([code, wcode, lits]) => [...fold(code, lits, js, argv), wcode]), js, argv);
  const found = [];
  const names = new Set();
  const done = new Set();
  const bound = new Map();
  const addAll = (set, more) => {
    for (const x of more) set.add(x);
  };
  for (const [code, lits, wcode] of stmts) {
    if (BODY_WRITE.search(wcode)) {
      const target = js ? withoutData(code) : headerBody(withoutData(code), wcode);
      found.push(...pathValues(target, lits));
      addAll(names, namesIn(target));
    }
    const m = ASSIGN.match(code);
    if (m) {
      if (!bound.has(m[1])) bound.set(m[1], []);
      bound.get(m[1]).push([m[2], lits]);
    }
  }
  const reach = (key, values, more) => {
    if (done.has(key)) return;
    done.add(key);
    found.push(...values);
    addAll(names, more);
  };

  for (let round = 0; round < 4; round++) {
    const size = names.size;
    stmts.forEach(([code, lits], i) => {
      let m = ASSIGN.match(code);
      if (m && names.has(m[1]) && !isData(m[2])) reach(`${i}\0${m[1]}`, pathValues(m[2], lits), namesIn(m[2]));
      m = js ? null : LOOP.match(code);
      if (m) {
        const loopNames = splitTop(pyStrip(pyStrip(m[1]), '()')).map((t) => pyStrip(t));
        const source = pyStrip(splitTop(m[2], ':')[0]);
        const named = NAMED_SOURCE.fullmatch(source);
        const origins = named ? (bound.get(named[1]) ?? []) : [[source, lits]];
        loopNames.forEach((name, k) => {
          if (!names.has(name)) return;
          const values = [];
          const more = namesIn(source);
          for (const [rhs, rhsLits] of origins) {
            const elements = elementValues(rhs, rhsLits, loopNames.length > 1 ? k : null, named ? (named[2] ?? null) : null);
            const split = SPLIT_SOURCE.fullmatch(rhs);
            if (split) { // `for f in 'a/x.md b/y.md'.split()`
              const sep = split[2] ? rhsLits[Number(split[2])] : null;
              values.push(...pySplit(rhsLits[Number(split[1])], sep).filter((v) => pathValues(lit(0), [v]).length));
            } else if (elements === null) { // `glob.glob('**/*.ts')`, a comprehension: what it walks
              if (WALK.search(rhs) || comprehension(rhs)) values.push(...pathValues(rhs, rhsLits));
              addAll(more, namesIn(rhs));
            } else values.push(...elements);
          }
          reach(`${i}\0${name}`, values, more);
        });
      }
      m = js ? null : DEF.match(code);
      if (m) {
        const params = splitTop(code.slice(end(m), argsEnd(code, end(m)))).map((a) => PARAM.match(a)[1]);
        const call = new PyRe(R`(?<![\w.$])${m[1]}\(`);
        params.forEach((param, k) => {
          if (!param || !names.has(param)) return;
          const keywordRx = new PyRe(R`\s*${param}\s*=(?!=)`);
          stmts.forEach(([other, otherLits], j) => {
            for (const c of call.finditer(j !== i ? other : '')) {
              const args = splitTop(other.slice(end(c), argsEnd(other, end(c))));
              const keyword = args.filter((a) => keywordRx.match(a)).map((a) => a.slice(a.indexOf('=') + 1));
              const positional = args.filter((a) => !KEYWORD_ARG.match(a));
              for (const a of keyword.length ? keyword : positional.slice(k, k + 1)) {
                reach(`${j}\0${c.index}\0${k}`, pathValues(a, otherLits), namesIn(a));
              }
            }
          });
        });
      }
    });
    if (names.size === size) break;
  }
  return found;
}

/** shlex.split, or plain whitespace words when the quoting does not close. */
function tokens(seg) {
  try {
    return shlexSplit(seg);
  } catch {
    return pySplit(seg);
  }
}

/** The files `command` writes, absolute, in order, once each. */
export function bashWriteTargets(command, cwd, { env = {}, home = '' } = {}) {
  home = respell(home);
  const [shell, mask, bodies] = scan(command);
  const local = new Map(SHELL_ENV.findall(shell).map(([k, v]) => [k, pyStrip(v, '\'"')]));
  const lookup = (name, fallback) => (local.has(name) ? local.get(name)
    : env[name] !== undefined && env[name] !== null ? String(env[name]) : fallback);
  const expand = (s) => {
    for (let round = 0; round < 3; round++) s = VAR.sub(s, (m) => lookup(m[1] || m[2], m[0])); // values may hold $VARs
    return expandUser(s, home);
  };

  const found = [];
  let here = respell(cwd); // the shell's directory at this point of the command; null after a cd we cannot resolve
  const subshells = []; // directory to restore when a ( … ) subshell closes
  const add = (p) => {
    p = respell(pyStrip(expand(p), '\'"'));
    if (!p || p.startsWith('-') || p.startsWith('/dev/') || p.includes('$')) return;
    if (!isAbs(p) && here === null) return; // relative to an unknown directory: drop rather than guess
    found.push(normpath(join(here || '/', p)));
  };
  const changeDir = (args) => {
    const target = respell(pyStrip(expand(args.length ? args[0] : '~'), '\'"'));
    if (target === '-' || target.includes('$') || target.includes('`')) here = null;
    else if (isAbs(target)) here = normpath(target);
    else if (here !== null) here = normpath(join(here, target));
  };

  const heredocCtx = []; // per heredoc opener: [shell directory, the interpreter that reads it or '', its argv]
  const bounds = [];
  let start = 0;
  for (const sep of SEPARATOR.finditer(mask)) {
    bounds.push([start, sep.index]);
    start = end(sep);
  }
  bounds.push([start, mask.length]);
  for (const [a, b] of bounds) {
    let segMask = mask.slice(a, b);
    const lead = end(LEAD.match(segMask));
    const trail = segMask.length - TRAIL.search(segMask.slice(lead))[0].length;
    for (const ch of segMask.slice(0, lead)) if (ch === '(') subshells.push(here);
    const closes = segMask.slice(trail).split(')').length - 1;
    const seg = shell.slice(a + lead, a + trail);
    segMask = segMask.slice(lead, trail);
    const kept = seg.split('');
    for (const m of REDIRECT.finditer(segMask)) {
      // `2>err`, `&>x` and `>&2` are stream plumbing, not the command's output file
      if (!m[1] && !['&', '<'].includes(segMask.slice(Math.max(m.index - 1, 0), m.index)) && !m[2].startsWith('&')) {
        add(seg.slice(m.indices[2][0], m.indices[2][1]));
      }
      for (let k = m.index; k < end(m); k++) kept[k] = ' ';
    }
    let tok = tokens(kept.join(''));
    while (tok.length && ASSIGN_WORD.match(tok[0])) tok = tok.slice(1); // env assignments
    const prog = tok.length ? basename(tok[0]) : '';
    let at = null;
    for (let k = 0; k < Math.min(tok.length, 2) && at === null; k++) {
      if (INTERPRETERS.some((name) => basename(tok[k]).startsWith(name))) at = k;
    }
    const interpreter = at !== null ? basename(tok[at]) : '';
    const scriptArgs = []; // `python3 - "$F" <<EOF` — the body reads them as sys.argv[1…]
    for (const t of at !== null ? tok.slice(at + 1) : []) {
      if (t.startsWith('<<')) break;
      if (!t.startsWith('-')) scriptArgs.push(expand(t));
    }
    const argv = (interpreter.startsWith('node') ? ['node', '-'] : ['-']).concat(scriptArgs);
    for (let k = OPENER.finditer(segMask).length; k > 0; k--) heredocCtx.push([here, interpreter, argv]);
    if (prog === 'cd' || prog === 'pushd') changeDir(tok.slice(1).filter((t) => t === '-' || !t.startsWith('-')));
    const args = [];
    let skip = false;
    for (const t of tok.slice(1)) {
      if (skip) skip = false;
      else if (t === '-e' || t === '-f') skip = true; // its value is a script, not a file to write
      else if (t && !t.startsWith('-')) args.push(t); // BSD `sed -i ''` leaves an empty arg
    }
    if (prog === 'tee') args.forEach(add);
    else if ((prog === 'sed' || prog === 'perl') && tok.slice(1).some((t) => t.startsWith('-i'))) {
      const hasScriptFlag = tok.slice(1).some((t) => t === '-e' || t === '-f');
      (hasScriptFlag && prog === 'sed' ? args : args.slice(1)).forEach(add); // else the 1st arg is the script
    } else if (SEG_WRITERS.has(prog)) args.forEach(add);
    else if (prog === 'cp' && args.length >= 2) add(args[args.length - 1]);
    for (let k = 0; k < closes; k++) if (subshells.length) here = subshells.pop();
  }

  // The interpreter is the program of the segment that opens the heredoc, not the line's first word.
  for (let k = 0; k < Math.min(bodies.length, heredocCtx.length); k++) {
    const [dirAt, interpreter, argv] = heredocCtx[k];
    if (!interpreter) continue;
    here = dirAt;
    heredocTargets(bodies[k], interpreter.startsWith('node'), argv).forEach(add);
  }
  return [...new Set(found)];
}
