#!/usr/bin/env node
// kit-links — do the kit pieces a project links in actually resolve on this machine; --fix links the missing ones.
//
// Why: `install.sh --link` puts gitignored symlinks into a project (skill folders, agent files) and writes a version
// marker into .claude/ that IS committed. The marker travels with git, the links do not: a second machine or a fresh
// worktree got the marker and no links, `--check` read the marker and said «up-to-date», and a hook that needs a linked
// script stayed silent — specs went unlinted for days. The truth is the link on disk, so this reads the links.
//
// What a project links in comes from its own .gitignore: every installer writes its links into a block
// `# >>> <pkg> --link >>>` … `# <<< <pkg> --link <<<`, so the list is committed even though the links are not.
// A path `.claude/<rest>` in <pkg>'s block comes from `<kit>/<pkg>/payload/<rest>`.
// A link that is missing in the project but resolves in the user's ~/.claude/<rest> counts as present: Claude Code reads
// both, and a second, project-level link would list the same skill twice in every prompt.
//
// Usage: kit-links.mjs [--fix] [--quiet] [--pkg <name>] [project]   (project: default the current directory)
//   prints one line per link that does not resolve (and what --fix did), then a summary line; --quiet prints only
//   problems. Exit 0 when every link resolves (or was fixed), 1 otherwise.
// The SessionStart twin that decides whether to start this at all: ~/.claude/skills/user-hooks/core/kit-links.mjs.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK = /^# >>> (\S+) --link >>>\s*$/;

/** `{pkg, path}` for every path line inside a `# >>> <pkg> --link >>>` block of a .gitignore text. */
export function linkedPaths(gitignore) {
  const out = [];
  let pkg = null;
  for (const raw of String(gitignore).split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    const open = BLOCK.exec(line);
    if (open) { pkg = open[1]; continue; }
    if (pkg && line === `# <<< ${pkg} --link <<<`) { pkg = null; continue; }
    if (pkg && line && !line.startsWith('#') && line.startsWith('.claude/')) out.push({ pkg, path: line.replace(/\/+$/, '') });
  }
  return out;
}

const resolves = (p) => { try { realpathSync(p); return true; } catch { return false; } };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** One link's state: ok | global | missing | dangling | nokit (the kit has no such source). */
export function inspect({ pkg, path }, { project, home = homedir(), kit = KIT }) {
  const rest = path.slice('.claude/'.length);
  const src = join(kit, pkg, 'payload', rest);
  const dst = join(project, path);
  if (resolves(dst)) return { pkg, path, src, dst, state: 'ok' };
  if (resolves(join(home, '.claude', rest))) return { pkg, path, src, dst, state: 'global' };
  if (!existsSync(src)) return { pkg, path, src, dst, state: 'nokit' };
  return { pkg, path, src, dst, state: isLink(dst) ? 'dangling' : 'missing' };
}

/** Links src at dst (a dangling link there is replaced; a real file or folder is never touched). */
function link({ src, dst }) {
  if (isLink(dst)) rmSync(dst, { force: true });
  mkdirSync(dirname(dst), { recursive: true });
  symlinkSync(src, dst, statSync(src).isDirectory() ? 'dir' : 'file');
}

export function run({ project, fix = false, pkg = null, home = homedir(), kit = KIT }) {
  let text = '';
  try { text = readFileSync(join(project, '.gitignore'), 'utf8'); } catch { /* no .gitignore: nothing linked */ }
  const items = linkedPaths(text).filter((i) => !pkg || i.pkg === pkg).map((i) => inspect(i, { project, home, kit }));
  for (const it of items) {
    if (!fix || (it.state !== 'missing' && it.state !== 'dangling')) continue;
    try {
      link(it);
      it.state = resolves(it.dst) ? 'fixed' : 'unfixed';
    } catch (e) {
      it.state = 'unfixed';
      it.error = e.code ?? e.message;
    }
  }
  return items;
}

const SAY = {
  missing: 'missing',
  dangling: 'a dead link',
  nokit: 'the kit has no source for it',
  fixed: 'was missing, linked now',
  unfixed: 'missing, linking failed',
};

export function report(items, { project, pkg, quiet }) {
  const lines = [];
  const bad = items.filter((i) => !['ok', 'global', 'fixed'].includes(i.state));
  for (const i of items.filter((x) => SAY[x.state])) {
    lines.push(`kit-links: ${i.path} — ${SAY[i.state]}${i.error ? ` (${i.error})` : ''}${i.state === 'nokit' ? ` (${i.src})` : ''}`);
  }
  if (bad.length) {
    lines.push(`kit-links: ${bad.length} of ${items.length} not resolving in ${project} — fix: node ${join(KIT, 'bin', 'kit-links.mjs')} --fix ${project}`);
  } else if (!quiet) {
    const global = items.filter((i) => i.state === 'global').length;
    lines.push(items.length
      ? `kit-links: ${items.length} link(s)${pkg ? ` of ${pkg}` : ''} resolve${global ? ` (${global} through ~/.claude)` : ''}`
      : `kit-links: no --link block${pkg ? ` of ${pkg}` : ''} in ${join(project, '.gitignore')}`);
  }
  return { lines, ok: bad.length === 0 };
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; };
  const fix = take('--fix');
  const quiet = take('--quiet');
  let pkg = null;
  const pi = args.indexOf('--pkg');
  if (pi >= 0) { pkg = args[pi + 1] ?? null; args.splice(pi, 2); }
  const project = resolve(args[0] ?? process.cwd());
  const items = run({ project, fix, pkg });
  const { lines, ok } = report(items, { project, pkg, quiet });
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = ok ? 0 : 1;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) main(process.argv.slice(2));
