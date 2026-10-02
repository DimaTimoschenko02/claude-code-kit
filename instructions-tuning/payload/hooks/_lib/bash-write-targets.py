#!/usr/bin/env python3
"""Print the files a Bash command is likely to WRITE, one absolute path per line.

Why: the path guards (skill-gate, frontmatter, done-evidence, task-toc) watch Write|Edit only, so a vault card
edited with `sed -i` or a python heredoc slipped past skill-gate. This finds the targets
of a Bash write so a guard can apply the same path rules to it.

Heuristic, tuned against false positives: reading a governed file (cat, grep, sed -n, `grep … > /tmp/x`) must
not count. A path counts only when it is
- the target of `>` / `>>` or an argument of `tee`;
- any path argument of a segment running `sed -i`, `perl -i`, `truncate`, `rm`, `mv`, or the last argument of `cp`;
- any path literal inside an interpreter heredoc (`python3 - <<EOF`, `node <<EOF`) whose body writes a file
  (`.write(`, `open(…, 'w'|'a')`, `write_text`, `writeFileSync`, …).
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
BODY_WRITE = re.compile(
    r"""\.write\(|write_text\(|writeFileSync|appendFileSync|writeFile\(|appendFile\(|os\.remove|os\.rename|"""
    r"""shutil\.(move|copy)|unlink|open\([^)]*['"][wa]\+?['"]"""
)
SEG_WRITERS = {"rm", "mv", "truncate"}


def tokens(seg):
    try:
        return shlex.split(seg, comments=False, posix=True)
    except ValueError:
        return seg.split()


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

    heredoc_ctx = []  # per heredoc opener, in order: (shell directory, opened by an interpreter)
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
        interpreted = prog.rstrip("0123456789.") in INTERPRETERS or any(
            os.path.basename(t).startswith(INTERPRETERS) for t in tok[:2]
        )
        heredoc_ctx += [(here[0], interpreted)] * len(OPENER.findall(seg_mask))
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
    for body, (dir_at, interpreted) in zip(bodies, heredoc_ctx):
        if not interpreted or not BODY_WRITE.search(body):
            continue
        here[0] = dir_at
        for lit in re.findall(r"""['"]([^'"\n]*/[^'"\n]*)['"]""", body):
            add(lit)

    seen = set()
    for p in found:
        if p not in seen:
            seen.add(p)
            print(p)


if __name__ == "__main__":
    main()
