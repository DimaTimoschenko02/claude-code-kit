#!/usr/bin/env python3
"""Print the files a Bash command is likely to WRITE, one absolute path per line.

Why: the path guards (skill-gate, frontmatter, done-evidence, task-toc) watch Write|Edit only, so a vault card
edited with `sed -i` or a python heredoc slipped past skill-gate. This finds the targets
of a Bash write so a guard can apply the same path rules to it.

Heuristic, tuned against false positives: reading a governed file (cat, grep, sed -n, `grep … > /tmp/x`) must
not count. A path counts only when it is
- the target of `>` / `>>` or an argument of `tee`;
- any path argument of a segment running `sed -i`, `perl -i`, `truncate`, `rm`, `mv`, or the last argument of `cp`;
- a path literal (holds a `/` or is a file name like `SKILL.md`) inside an interpreter heredoc (`python3 - <<EOF`,
  `node <<EOF`) that sits in a statement making a write call (`open(…, 'w'|'a')`, `write_text`, `writeFileSync`,
  `os.remove`, …; a statement runs on while its brackets are open) outside the call's data argument, or that is bound to
  a name such a statement reads: `p = Path('/v') / 'x.md'`, `const p = path.join(…)`, and in Python `for p in […]` or
  the argument of `rep('a/x.md', …)` for `def rep(p, …)`. A path quoted as data — a report row, a dict value, a print —
  is not a write target: counting every literal of a writing body denied a TSV whose rows cited `~/.claude/hooks/x.sh`
  as an edit of that hook.
The body of a data heredoc (`cat > f <<EOF`) is text, not commands — it is dropped (hook checklist item 6).
Shell variables assigned in the same command (`f=path; sed -i … $f`) are substituted.
A relative path resolves against the shell's directory at that point of the command: `cd`/`pushd` move it, a `( … )`
subshell restores it, an unresolvable `cd` (`cd -`, `cd $(…)`) drops relative paths after it. Resolving
against the session cwd instead blocked `cd $JOB_DIR/tmp && cat > q.sql` as an edit of `apps/api/src/q.sql`, and the
mirror case `cd repo/apps/api && sed -i … src/x.ts` from the workspace root resolved outside `apps/` and went ungated.

Quotes, comments and heredoc bodies are read by `shell_text.scan`: a `;`, `>` or `<<EOF` inside a quoted string is
text, not shell syntax.

Usage: bash-write-targets.py <cwd>   (command on stdin)
"""
import os
import re
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_text import OPENER, scan  # noqa: E402

INTERPRETERS = ("python", "python3", "node", "perl", "ruby")
SEG_WRITERS = {"rm", "mv", "truncate"}

# Interpreter heredoc bodies — heredoc_targets(). In a statement's code string literal i stands as \x01i\x02, so a
# bracket, `#` or `;` inside a string is text.
LIT = re.compile(r"\x01(\d+)\x02")
_L, _PATH = LIT.pattern, r"(?:pathlib\.)?(?:Pure)?(?:Posix)?Path"
# Read on a statement whose literals are emptied except a short mode ('w', 'ab+', '>'): `open(` may hold a nested call
# (`open(os.path.join(…), 'w')`) and a quoted `.write(` is text.
BODY_WRITE = re.compile(
    r"""\.write\(|write_text\(|write_bytes\(|writeFileSync|appendFileSync|writeFile\(|appendFile\(|createWriteStream|"""
    r"""os\.remove|os\.rename|os\.replace|shutil\.(move|copy|rmtree)|unlink|\brmSync|renameSync|copyFileSync|"""
    r"""open(?:Sync)?\((?:[^()]|\([^()]*\))*['"](?:[wax]|r[bt]?\+|>>?)[bt+]*['"]"""
)
MODE = re.compile(r"[rwxabt+<>]{1,4}")
FILE_NAME = re.compile(r"[^\s/'\"\\]+\.[A-Za-z][\w-]{0,9}")  # a bare `SKILL.md`: written into the shell's directory
# What a write call writes is data, not where it writes: every argument of `f.write(…)` / `p.write_text(…)` (and the
# file object `f`), all but the first of `fs.writeFileSync(p, …)` / Ruby `File.write(p, …)`, the first of `json.dump`.
DATA_ARGS = (
    (re.compile(r"(?<!File)(?<!IO)\.write\(|\.writelines\(|write_text\(|write_bytes\("), "all"),
    (re.compile(r"(?<![\w.$])(?:File|IO)\.write\(|(?:writeFile|appendFile)(?:Sync)?\("), "rest"),
    (re.compile(r"(?<![\w.$])(?:json|yaml|pickle|toml)\.dump\("), "first"),
)
# Path expressions made of literals only, folded into one literal, innermost first.
FOLDS = (
    (re.compile(rf"(?<![\w.$]){_PATH}\.home\(\s*\)|(?<![\w.$])os\.homedir\(\s*\)"), lambda v, js: "~"),
    (re.compile(rf"(?<![\w.$])(?:{_PATH}\.cwd|os\.getcwd|process\.cwd)\(\s*\)"), lambda v, js: "."),
    (re.compile(rf"(?<![\w.$])(?:{_PATH}|os\.path\.(?:expanduser|abspath|realpath|normpath)|os\.fspath|str|String)"
                rf"\(\s*{_L}\s*\)|{_L}\.(?:expanduser|resolve|absolute)\(\s*\)"), lambda v, js: v[0]),
    (re.compile(rf"(?<![\w.$])(?:{_PATH}|os\.path\.join|posixpath\.join|path\.resolve|(?P<js>path\.join))"
                rf"\(\s*{_L}(?:\s*,\s*{_L})*\s*,?\s*\)"), None),  # join: node's path.join only concatenates
    (re.compile(rf"{_L}\s*/\s*{_L}"), lambda v, js: os.path.join(*v)),  # pathlib's `/`
    (re.compile(rf"{_L}\s*\+\s*{_L}"), lambda v, js: "".join(v)),
    (re.compile(rf"(?<![\w$\])])\(\s*{_L}\s*\)"), lambda v, js: v[0]),
)
PATH_CALL = re.compile(rf"(?<![\w.$])(?:(?:os\.)?path\.\w+|posixpath\.\w+|{_PATH}|os\.fspath|str|String)\s*\(")
ASSIGN = re.compile(r"\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w.]+\s*)?=(?!=)(.*)", re.S)
LOOP = re.compile(r"\s*(?:async\s+)?for\s+(.+?)\s+in\s+(.*)", re.S)  # Python: targets, then the source up to `:`
DEF = re.compile(r"\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(")
# A loop over these walks paths, so the paths it starts from count; a loop over anything else (`open(…)`, a call's
# result) yields data.
WALK = re.compile(r"(?<![\w$])(?:i?glob|rglob|iterdir|listdir|scandir|walk|readdirSync)\s*\(")


def tokens(seg):
    try:
        return shlex.split(seg, comments=False, posix=True)
    except ValueError:
        return seg.split()


def statements(body, js):
    """An interpreter heredoc body as statements: a line plus its continuation lines while (), [], {} are open — in JS
    a block `{` does not hold the statement, or a whole function would be one — also cut at `;`. Each is
    (code, wcode, lits): comments dropped, string literal i in code as \\x01i\\x02, in wcode emptied unless a MODE."""
    out, code, wcode, lits, stack = [], [], [], [], []
    i, n = 0, len(body)

    def put(c, w=None):
        code.append(c)
        wcode.append(c if w is None else w)

    def cut():
        if "".join(code).strip():
            out.append(("".join(code), "".join(wcode), list(lits)))
        for part in (code, wcode, lits):
            part.clear()

    while i < n:
        ch = body[i]
        if ch in "'\"" or (js and ch == "`"):
            q = body[i:i + 3] if not js and body[i:i + 3] in ("'''", '"""') else ch
            j = i + len(q)
            while j < n and not body.startswith(q, j) and not (ch in "'\"" and len(q) == 1 and body[j] == "\n"):
                j += 2 if body[j] == "\\" else 1
            text = body[i + len(q):j]
            j = j + len(q) if body.startswith(q, j) else j  # an unclosed quote ends at its line
            prefix = None if js else re.search(r"(?<![\w$])[rRbBuUfF]{1,2}$", "".join(code[-3:]))
            if prefix:  # f'…', rb'…': the prefix is part of the literal
                del code[-len(prefix.group()):], wcode[-len(prefix.group()):]
            put(f"\x01{len(lits)}\x02", body[i:j] if MODE.fullmatch(text) else ch * 2)
            lits.append(text)
            i = j
        elif (js and body.startswith("//", i)) or (not js and ch == "#"):
            end = body.find("\n", i)
            i = n if end < 0 else end
        elif js and body.startswith("/*", i):
            end = body.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif ch == "\\" and body.startswith("\n", i + 1):
            put(" ")
            i += 2
        elif ch in "\n;" and (not stack or (js and stack[-1] == "{")):
            cut()
            i += 1
        else:
            if ch in "([{":
                stack.append(ch)
            elif ch in ")]}" and stack:
                stack.pop()
            put(ch)
            i += 1
    cut()
    return out


def fold(code, lits, js, argv):
    """code with each path expression of literals only (FOLDS) and each `sys.argv[N]` / `process.argv[N]` replaced by
    one new literal of its value; lits grown to match."""
    lits = list(lits)

    def new(value):
        lits.append(value)
        return f"\x01{len(lits) - 1}\x02"

    code = re.sub(r"(?<![\w.$])(?:sys|process)\.argv\[(\d+)\]",
                  lambda m: new(argv[int(m.group(1))]) if int(m.group(1)) < len(argv) else m.group(), code)
    for _ in range(100):
        for rx, value in FOLDS:
            m = rx.search(code)
            if m:
                v = [lits[int(x)] for x in LIT.findall(m.group())]
                path = ("/".join(v) if js and m.group("js") else os.path.join(*v)) if value is None else value(v, js)
                code = code[:m.start()] + new(path) + code[m.end():]
                break
        else:
            break
    return code, lits


def args_end(code, at):
    """Index of the bracket that closes the call whose arguments start at `at`."""
    depth = 0
    while at < len(code) and not (code[at] in ")]}" and depth == 0):
        depth += (code[at] in "([{") - (code[at] in ")]}")
        at += 1
    return at


def split_top(text, sep=","):
    """text cut at `sep` outside brackets."""
    parts, depth, start = [], 0, 0
    for k, ch in enumerate(text):
        depth += (ch in "([{") - (ch in ")]}")
        if ch == sep and depth == 0:
            parts.append(text[start:k])
            start = k + 1
    return parts + [text[start:]]


def comprehension(code):
    """A list, set, dict or generator comprehension: a `for` right inside its outer brackets, not in a nested one."""
    code = code.strip()
    if code[:1] not in ("[", "(", "{") or args_end(code, 1) != len(code) - 1:
        return False
    top, depth = [], 0
    for ch in code[1:-1]:
        depth -= ch in ")]}"
        top.append(ch if depth == 0 else " ")
        depth += ch in "([{"
    return re.search(r"\bfor\b", "".join(top)) is not None


def without_data(code):
    """The part of a write statement that says where it writes: DATA_ARGS blanked."""
    out = list(code)
    for rx, kind in DATA_ARGS:
        for m in rx.finditer(code):
            end = args_end(code, m.end())
            first = len(split_top(code[m.end():end])[0])
            start, stop = {"all": (m.end(), end), "rest": (m.end() + first + 1, end), "first": (m.end(), m.end() + first)}[kind]
            if kind == "all" and code[m.start()] == ".":  # the file object `f` of `f.write(…)` is no path either
                start = re.search(r"[\w$.]*$", code[:m.start()]).start()
            out[start:stop] = " " * max(stop - start, 0)
    return "".join(out)


HEADER = re.compile(r"\s*(?:async\s+)?(?:for|while|if|elif)\b")


def header_body(code, wcode):
    """A one-line compound statement's body, its header blanked: in `for c in rows: f.write(c)` the header names what the
    body walks or tests, the body says where it writes. The loop itself is still followed from the whole statement.
    A header that writes itself (`if (f := open(p, 'w')): …`, `with open(…) as f:`) is kept: there the header is the write."""
    parts = split_top(code, ":") if HEADER.match(code) else []
    if len(parts) < 2 or BODY_WRITE.search(split_top(wcode, ":")[0]):
        return code
    head = len(parts[0]) + 1
    return " " * head + code[head:]


def path_values(code, lits):
    """The literals in a piece of folded code that are paths: they hold a `/` or are a FILE_NAME."""
    values = (lits[int(x)] for x in LIT.findall(code))
    return [p for p in values if ("/" in p or FILE_NAME.fullmatch(p)) and "\n" not in p]


def names_in(code):
    """The names a piece of code reads: not attributes, not path calls, not the `as f` of `with open(…) as f`."""
    code = re.sub(r"\bas\s+[\w$]+", " ", PATH_CALL.sub("(", LIT.sub(" ", code)))
    return set(re.findall(r"(?<![\w$.])[A-Za-z_$][\w$]*", code))


def is_data(rhs):
    """A literal list, tuple, dict, set or comprehension: values, not one path. Any other right-hand side of a name a
    write reads builds that path (`Path(…) / x`, `os.path.join(root, f)`, `expanduser(fn)`)."""
    rhs = rhs.strip()
    inner = rhs[1:-1] if rhs[:1] == "(" and args_end(rhs, 1) == len(rhs) - 1 else None  # the whole rhs in ( )
    return rhs[:1] in ("[", "{") or len(split_top(rhs)) > 1 or rhs.startswith("lambda") or (
        inner is not None and len(split_top(inner)) > 1) or comprehension(rhs)


def element_values(container, lits, k, view):
    """Paths in the elements of a literal list / tuple / dict a loop walks: element k of each tuple when the loop unpacks
    (`for p, old, new in [(…), …]`), a dict's keys — its values over `.values()` or as k == 1 over `.items()`. None when
    the source is no literal container: a call, a comprehension."""
    c = container.strip()
    if c[:1] not in ("[", "(", "{") or c[-1:] not in ("]", ")", "}") or comprehension(c):
        return None
    out = []
    for el in split_top(c[1:-1]):
        entry = split_top(el, ":") if c[0] == "{" else [el]
        if len(entry) == 2:
            part = entry[1] if view == "values" or (view == "items" and k == 1) else entry[0]
        else:
            e = el.strip()
            items = split_top(e[1:-1]) if k is not None and e[:1] in "([" and e[-1:] in ")]" else [e]
            part = items[k] if k is not None and k < len(items) else items[0] if k is None else ""
        out += path_values(part, lits)
    return out


def constants(stmts, js, argv):
    """stmts with every read of a name bound once, to one path literal (`D = '/tmp/sql/'`), replaced by that literal and
    folded again: `open(D + 'x.sql', 'w')` writes `/tmp/sql/x.sql`, not `x.sql` in the shell's directory. A name bound
    anywhere else too — another assignment, `+=`, a loop, a parameter, `as` — keeps its reads."""
    text = "\n".join(code for code, _, _ in stmts)
    values = {}
    for code, lits, _ in stmts:
        m = ASSIGN.match(code)
        if m:
            lit = LIT.fullmatch(m.group(2).strip())
            values.setdefault(m.group(1), []).append(lits[int(lit.group(1))] if lit and path_values(lit.group(), lits) else None)
    for name, vals in values.items():
        n = re.escape(name)
        binds = len(re.findall(rf"(?<![\w.$]){n}\s*(?:[-+*/%|&^@]|//|\*\*|>>|<<)?=(?!=)", text)) + len(re.findall(
            rf"(?<![\w.$]){n}\s*,[^=\n]*=(?!=)|\bfor\s[^\n]*?(?<![\w.$]){n}(?![\w$])[^\n]*?\s(?:in|of)\s|"
            rf"\b(?:as|def|function|catch|global|nonlocal|import)\b[^\n{{:=]*?(?<![\w.$]){n}(?![\w$])|"
            rf"(?<![\w.$]){n}\s*(?:,[^()\n]*)?\)?\s*=>", text))
        if len(vals) != 1 or vals[0] is None or binds != 1:
            continue
        read = re.compile(rf"(?<![\w.$]){n}(?![\w$])(?!\s*(?::\s*[\w.]+\s*)?=(?!=))")
        for i, (code, lits, wcode) in enumerate(stmts):
            if read.search(code):
                lits = lits + [vals[0]]
                stmts[i] = fold(read.sub(f"\x01{len(lits) - 1}\x02", code), lits, js, argv) + (wcode,)
    return stmts


def heredoc_targets(body, js, argv):
    """Paths an interpreter heredoc writes: the path literals of its write statements, then of every binding of a name
    such a statement reads — an assignment that is not data (`p = Path('/v') / 'x.md'`); in Python also the loop that
    binds it (`for p in ['a/x.md', …]`, `for p, subs in edits.items()`, `for f in glob.glob('apps/**/*.ts')`) and, for a
    parameter (`def rep(p, old, new)`), that argument at every call. A name read by a binding is followed too
    (`p = Path(f)` → `for f in …`), a few rounds deep."""
    stmts = constants([fold(code, lits, js, argv) + (wcode,) for code, wcode, lits in statements(body, js)], js, argv)
    found, names, done, bound = [], set(), set(), {}
    for code, lits, wcode in stmts:
        if BODY_WRITE.search(wcode):
            target = without_data(code) if js else header_body(without_data(code), wcode)
            found += path_values(target, lits)
            names |= names_in(target)
        m = ASSIGN.match(code)
        if m:
            bound.setdefault(m.group(1), []).append((m.group(2), lits))

    def reach(key, values, more):
        if key not in done:
            done.add(key)
            found.extend(values)
            names.update(more)

    for _ in range(4):
        size = len(names)
        for i, (code, lits, _) in enumerate(stmts):
            m = ASSIGN.match(code)
            if m and m.group(1) in names and not is_data(m.group(2)):
                reach((i, m.group(1)), path_values(m.group(2), lits), names_in(m.group(2)))
            m = None if js else LOOP.match(code)
            if m:
                loop_names = [t.strip() for t in split_top(m.group(1).strip().strip("()"))]
                source = split_top(m.group(2), ":")[0].strip()
                named = re.fullmatch(r"([A-Za-z_]\w*)(?:\.(items|keys|values)\(\s*\))?", source)
                origins = bound.get(named.group(1), []) if named else [(source, lits)]
                for k, name in enumerate(loop_names):
                    if name not in names:
                        continue
                    values, more = [], names_in(source)
                    for rhs, rhs_lits in origins:
                        elements = element_values(rhs, rhs_lits, k if len(loop_names) > 1 else None,
                                                  named and named.group(2))
                        split = re.fullmatch(rf"\s*{_L}\.split(?:lines)?\(\s*(?:{_L})?\s*\)\s*", rhs)
                        if split:  # `for f in 'a/x.md b/y.md'.split()`
                            sep = rhs_lits[int(split.group(2))] if split.group(2) else None
                            values += [v for v in rhs_lits[int(split.group(1))].split(sep) if path_values("\x010\x02", [v])]
                        elif elements is None:  # `glob.glob('**/*.ts')`, `[expanduser(x) for x in […]]`: what it walks
                            values += path_values(rhs, rhs_lits) if WALK.search(rhs) or comprehension(rhs) else []
                            more |= names_in(rhs)
                        else:
                            values += elements
                    reach((i, name), values, more)
            m = None if js else DEF.match(code)
            if m:
                params = [re.match(r"\s*\**(\w*)", a).group(1) for a in split_top(code[m.end():args_end(code, m.end())])]
                call = re.compile(r"(?<![\w.$])" + re.escape(m.group(1)) + r"\(")
                for k, param in enumerate(params):
                    if not param or param not in names:
                        continue
                    for j, (other, other_lits, _) in enumerate(stmts):
                        for c in call.finditer(other if j != i else ""):
                            args = split_top(other[c.end():args_end(other, c.end())])
                            keyword = [a.split("=", 1)[1] for a in args if re.match(rf"\s*{param}\s*=(?!=)", a)]
                            positional = [a for a in args if not re.match(r"\s*\w+\s*=(?!=)", a)]
                            for a in keyword or positional[k:k + 1]:
                                reach((j, c.start(), k), path_values(a, other_lits), names_in(a))
        if len(names) == size:
            break
    return found


def main():
    cwd = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    cmd = sys.stdin.read()
    shell, mask, bodies = scan(cmd)

    env = dict(re.findall(r"(?:^|[\s;&|(])([A-Za-z_]\w*)=(\"[^\"]*\"|'[^']*'|[^\s;&|]+)", shell))
    env = {k: v.strip("'\"") for k, v in env.items()}

    def expand(s):
        for _ in range(3):  # values may reference other variables or $HOME
            s = re.sub(
                r"\$\{(\w+)\}|\$(\w+)",
                lambda m: env.get(m.group(1) or m.group(2), os.environ.get(m.group(1) or m.group(2), m.group(0))),
                s,
            )
        return os.path.expanduser(s)

    found = []
    here = [cwd]  # the shell's directory at this point of the command; None after a cd we cannot resolve
    subshells = []  # directory to restore when a ( … ) subshell closes

    def add(p):
        p = expand(p).strip("'\"")
        if not p or p.startswith("-") or p.startswith("/dev/") or "$" in p:
            return
        if not os.path.isabs(p) and here[0] is None:
            return  # relative to an unknown directory: drop rather than guess
        found.append(os.path.normpath(os.path.join(here[0] or "/", p)))

    def change_dir(args):
        target = expand(args[0] if args else "~").strip("'\"")
        if target == "-" or "$" in target or "`" in target:
            here[0] = None
        elif os.path.isabs(target):
            here[0] = os.path.normpath(target)
        elif here[0] is not None:
            here[0] = os.path.normpath(os.path.join(here[0], target))

    heredoc_ctx = []  # per heredoc opener, in order: (shell directory, the interpreter that reads it or "", its argv)
    bounds, start = [], 0  # segments are cut where the mask has a separator, so a quoted `;` or `|` cuts nothing
    for sep in re.finditer(r"\n|;|&&|\|\||\|", mask):
        bounds.append((start, sep.start()))
        start = sep.end()
    bounds.append((start, len(mask)))
    for a, b in bounds:
        seg_mask = mask[a:b]
        lead = re.match(r"[\s(]*", seg_mask).end()
        trail = len(seg_mask) - len(re.search(r"[\s)]*$", seg_mask[lead:]).group(0))
        for _ in range(seg_mask[:lead].count("(")):
            subshells.append(here[0])
        closes = seg_mask[trail:].count(")")
        seg, seg_mask = shell[a + lead:a + trail], seg_mask[lead:trail]
        kept = list(seg)
        for m in re.finditer(r"(\d?)>>?\s*(\"[^\"]+\"|'[^']+'|[^\s;&|<>]+)", seg_mask):
            # `2>err`, `&>x` and `>&2` are stream plumbing, not the command's output file
            if not m.group(1) and not seg_mask[max(m.start() - 1, 0):m.start()] in ("&", "<") \
                    and not m.group(2).startswith("&"):
                add(seg[m.start(2):m.end(2)])
            kept[m.start():m.end()] = " " * (m.end() - m.start())
        tok = tokens("".join(kept))
        # skip env assignments and sudo-like prefixes
        while tok and re.match(r"^[A-Za-z_]\w*=", tok[0]):
            tok = tok[1:]
        prog = os.path.basename(tok[0]) if tok else ""
        at = next((k for k, t in enumerate(tok[:2]) if os.path.basename(t).startswith(INTERPRETERS)), None)
        interpreter = os.path.basename(tok[at]) if at is not None else ""
        script_args = []  # `python3 - "$F" <<EOF` — the body reads them as sys.argv[1…]
        for t in tok[at + 1:] if at is not None else []:
            if t.startswith("<<"):
                break
            if not t.startswith("-"):
                script_args.append(expand(t))
        argv = (["node", "-"] if interpreter.startswith("node") else ["-"]) + script_args
        heredoc_ctx += [(here[0], interpreter, argv)] * len(OPENER.findall(seg_mask))
        if prog in ("cd", "pushd"):
            change_dir([t for t in tok[1:] if t == "-" or not t.startswith("-")])
        args, skip = [], False
        for t in tok[1:]:
            if skip:
                skip = False
            elif t in ("-e", "-f"):
                skip = True  # its value is a script, not a file to write
            elif t and not t.startswith("-"):  # BSD `sed -i ''` leaves an empty arg
                args.append(t)
        if prog == "tee":
            for a in args:
                add(a)
        elif prog in ("sed", "perl") and any(t == "-i" or t.startswith("-i") for t in tok[1:]):
            # first non-flag arg of sed is the script; paths are the rest
            has_script_flag = any(t in ("-e", "-f") for t in tok[1:])
            for a in (args if has_script_flag and prog == "sed" else args[1:]):  # else the 1st arg is the script
                add(a)
        elif prog in SEG_WRITERS:
            for a in args:
                add(a)
        elif prog == "cp" and len(args) >= 2:
            add(args[-1])
        for _ in range(closes):
            if subshells:
                here[0] = subshells.pop()

    # The interpreter is the program of the segment that opens the heredoc, not the line's first word:
    # `cd brain && python3 - <<EOF` was skipped as a `cd` line and its writes went unseen.
    for body, (dir_at, interpreter, argv) in zip(bodies, heredoc_ctx):
        if not interpreter:
            continue
        here[0] = dir_at
        for p in heredoc_targets(body, interpreter.startswith("node"), argv):
            add(p)

    seen = set()
    for p in found:
        if p not in seen:
            seen.add(p)
            print(p)


if __name__ == "__main__":
    main()
