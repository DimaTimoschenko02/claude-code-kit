#!/usr/bin/env python3
"""Compact learning-log: drop closed (addressed/wontfix) blocks, keep open.
Daily files with no open blocks are deleted. Registry (resolutions.md) untouched —
it is the durable per-pattern record (Recur counter)."""
import os, re, sys, glob

ROOT = os.path.expanduser("~/work/.claude/learning-log")
stats = {"addressed": 0, "wontfix": 0, "open": 0, "files_deleted": 0, "files_rewritten": 0}

def split_blocks(text):
    """Return (header, [blocks]) where blocks start at '## '."""
    lines = text.splitlines(keepends=True)
    header, blocks, cur = [], [], None
    for ln in lines:
        if ln.startswith("## "):
            if cur is not None:
                blocks.append(cur)
            cur = [ln]
        elif cur is None:
            header.append(ln)
        else:
            cur.append(ln)
    if cur is not None:
        blocks.append(cur)
    return "".join(header), ["".join(b) for b in blocks]

def block_status(block):
    m = re.search(r"\*\*Status:\*\*\s*(\w+)", block)
    return m.group(1) if m else "unknown"

targets = sorted(glob.glob(os.path.join(ROOT, "2026-*", "*.md"))) + [os.path.join(ROOT, "wins", "candidates.md")]
for path in targets:
    if not os.path.isfile(path):
        continue
    with open(path) as f:
        text = f.read()
    header, blocks = split_blocks(text)
    keep = []
    for b in blocks:
        st = block_status(b)
        if st in ("addressed", "wontfix"):
            stats[st] += 1
        else:
            stats["open"] += 1
            keep.append(b)
    if not keep and "wins" not in path:
        os.remove(path)
        stats["files_deleted"] += 1
        print(f"deleted  {os.path.relpath(path, ROOT)}")
        continue
    new = header.rstrip("\n") + "\n\n" + "\n".join(k.strip("\n") + "\n" for k in keep) if keep else header
    if new != text:
        with open(path, "w") as f:
            f.write(new)
        stats["files_rewritten"] += 1
        print(f"rewrote  {os.path.relpath(path, ROOT)}  (open kept: {len(keep)})")

# drop empty month dirs
for d in glob.glob(os.path.join(ROOT, "2026-*")):
    if os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)
        print(f"rmdir    {os.path.basename(d)}")

print("\nSummary:", stats)
