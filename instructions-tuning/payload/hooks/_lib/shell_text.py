#!/usr/bin/env python3
"""Quote-aware reading of a Bash command for the hooks that inspect commands.

Why one scanner: three hooks cut heredoc bodies with their own regex and none of them saw quotes. A commit
message `-m "… python3 - <<EOF …"` opened a «heredoc» inside the quotes: commit-pathspec-guard dropped the rest of the
command with its `-- <paths>` and blocked a correct commit; the same blindness let a quoted `<<X` hide the next lines
from prod-host-guard and bash-write-targets (a write or an ssh passing unseen).

scan(cmd) -> (raw, mask, bodies)
- raw   — the command without heredoc bodies and without `# comments` (comment text becomes spaces);
- mask  — raw with every quoted character replaced by `x` (the quote marks stay) and `<<<` herestrings masked, the same
          length as raw: find separators, redirects and heredoc openers in mask, read the words at those positions in raw;
- bodies — heredoc bodies in opener order; OPENER finds the same openers in mask (an opener inside `"$(…)"` is real
          and is left unmasked for that).

strip(cmd, keep) — raw plus every body fed to a shell (`bash <<EOF`, `ssh host <<EOF`, `cat <<EOF | sh`) whose kind is
in keep ("local", "remote" = ssh), right after its opener's line: those lines are commands too. Second half:
hooks that grep a command for words read every heredoc body as commands — server-ops-hint fired on a note, block-secrets
denied a python heredoc whose string said «eval loops»; cutting every body instead blinds them to `ssh h <<EOF … psql`.

CLI: `shell_text.py strip [--keep-shell | --keep-local-shell]` prints strip() for a command on stdin (hooks not in Python).
"""
import os
import re
import sys

OPENER = re.compile(r"<<-?\s*\\?(['\"]?)([A-Za-z_]\w*)\1")
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
SOURCERS = {".", "source", "eval"}  # run their input as shell only as the program, not as an argument
WRAPPERS = {"sudo", "env", "exec", "nohup", "time", "command", "nice"}
SSH_VALUE_OPTS = set("BbcDEeFIiJLlmOoPpQRSWw")
REDIRECT = re.compile(r"\d*(<|>|&>)")


def scan(cmd):
    lines = cmd.split("\n")
    raw, mask, bodies = [], [], []
    quote = None  # the quote char open at this point, carried across lines
    subst = 0  # `$(` opened inside the current double-quoted string and not closed yet
    i = 0
    while i < len(lines):
        line = lines[i]
        r, m = list(line), list(line)
        pending = []
        k = 0
        while k < len(line):
            ch = line[k]
            if quote:
                if quote == '"' and ch == "\\" and k + 1 < len(line):
                    m[k] = m[k + 1] = "x"
                    k += 2
                    continue
                if quote == '"' and line.startswith("$(", k):
                    subst += 1
                elif quote == '"' and ch == ")" and subst:
                    subst -= 1
                elif quote == '"' and subst and line.startswith("<<<", k):
                    m[k:k + 3] = "xxx"
                    k += 3
                    continue
                elif quote == '"' and subst and ch == "<" and OPENER.match(line, k):
                    # `git commit -m "$(cat <<'EOF'` — a real heredoc inside a command substitution
                    found = OPENER.match(line, k)
                    pending.append(found.group(2))
                    k = found.end()
                    continue
                if ch == quote:
                    quote = None
                else:
                    m[k] = "x"
                k += 1
            elif ch == "\\":
                k += 2
            elif ch in "\"'":
                quote = ch
                subst = 0
                k += 1
            elif ch == "#" and (k == 0 or line[k - 1] in " \t;&|("):
                for j in range(k, len(line)):
                    r[j] = m[j] = " "
                break
            elif line.startswith("<<<", k):
                m[k:k + 3] = "   "
                k += 3
            elif ch == "<" and OPENER.match(line, k):
                found = OPENER.match(line, k)
                pending.append(found.group(2))
                k = found.end()
            else:
                k += 1
        raw.append("".join(r))
        mask.append("".join(m))
        i += 1
        for tag in pending:  # a body starts on the next line; the opener must be outside quotes to get here
            body = []
            while i < len(lines) and lines[i].strip() != tag:
                body.append(lines[i])
                i += 1
            i += 1
            bodies.append("\n".join(body))
        if quote and i < len(lines):
            mask[-1] += "\0"  # a newline inside quotes is quoted text, not a command separator
    raw_text = "\n".join(raw)
    mask_text = "".join(part[:-1] + "x" if part.endswith("\0") else part + "\n" for part in mask)[: len(raw_text)]
    return raw_text, mask_text, bodies


def shell_fed(seg, seg_mask):
    """Who runs the body of a heredoc opened in this command list segment: "remote" for `ssh host` with no remote
    command or one that runs a shell (`ssh h 'bash -s'`, `cat <<EOF | ssh h`); "local" for bash/sh/zsh anywhere unquoted
    in the pipeline (`bash <<EOF`, `sudo sh`, `cat <<EOF | bash`, `docker exec -i c sh`) or `.`/`source`/`eval` as the
    program; None when the body is data or another program's input (`cat > f`, `python3 -`, `psql`)."""
    cmds, cur = [], []
    for m in re.finditer(r"\||[^\s|]+", seg_mask):
        if m.group() == "|":
            cmds.append(cur)
            cur = []
        elif not REDIRECT.match(m.group()):
            cur.append((seg[m.start():m.end()], m.group()))
    cmds.append(cur)
    for words in cmds:
        prog = [raw for raw, _ in words if not re.match(r"[A-Za-z_]\w*=", raw)]
        while prog and prog[0] in WRAPPERS:
            prog = prog[1:]
        if prog and os.path.basename(prog[0]) == "ssh":
            i = 1
            while i < len(prog) and prog[i].startswith("-"):
                i += 2 if len(prog[i]) == 2 and prog[i][1] in SSH_VALUE_OPTS else 1
            remote = re.split(r"[\s;&|()]+", " ".join(w.strip("'\"") for w in prog[i + 1:]).strip())
            if remote == [""] or any(os.path.basename(w) in SHELLS for w in remote):
                return "remote"
            continue
        if prog and prog[0] in SOURCERS:
            return "local"
        if any(os.path.basename(raw) in SHELLS for raw, masked in words if raw == masked):  # unquoted words only
            return "local"
    return None


def strip(cmd, keep=()):
    """raw from scan(), plus the bodies whose shell_fed() kind is in `keep`, each right after its opener's line."""
    raw, mask, bodies = scan(cmd)
    if not keep or not bodies:
        return raw
    at, fed, start = [], [], 0  # per opener: raw line index, who runs its body
    for sep in [*re.finditer(r"\n|;|&&|\|\|", mask), None]:
        end = sep.start() if sep else len(mask)
        for m in OPENER.finditer(mask, start, end):
            at.append(raw.count("\n", 0, m.start()))
            fed.append(shell_fed(raw[start:end], mask[start:end]))
        if sep is None:
            break
        start = sep.end()
    if len(at) != len(bodies):  # openers and bodies out of step: read every body rather than miss a command
        return raw + "\n" + "\n".join(bodies)
    lines = raw.split("\n")
    for j in reversed(range(len(bodies))):
        if fed[j] in keep:
            lines.insert(at[j] + 1, bodies[j])
    return "\n".join(lines)


if __name__ == "__main__":
    if sys.argv[1:2] == ["strip"]:
        flags = sys.argv[2:]
        keep = ("local", "remote") if "--keep-shell" in flags else ("local",) if "--keep-local-shell" in flags else ()
        sys.stdout.write(strip(sys.stdin.read(), keep))
