#!/usr/bin/env node
// PostToolUse hook of the instructions-tuning skill (its frontmatter `hooks:`): after a Write or Edit of a SKILL.md or
// an agent definition, checks the frontmatter the way Claude Code will read it. A broken one fails silently — the
// skill never lists, the agent never routes — so the check runs on the edit instead of the agent remembering to.
// Exit 2 puts the problems in front of the model; the edit itself stands. Any other file: exit 0 at once.
//
// Node, not ruby: node is on every machine that runs Claude Code, ruby was on none of ours, so the check never ran
// there and nothing said so. The YAML reader is js-yaml, vendored as one file (vendor/, MIT, no install step) and
// loaded only once a file turns out to be a SKILL.md or an agent definition.
//
// usage: hook stdin (PostToolUse JSON), or frontmatter-check.mjs <file> for a manual run
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
// A one-line top-level value that is not quoted, a block scalar or a flow collection.
const ONE_LINE = /^([A-Za-z_-]+):[ \t]+(?!["'|>[{])([^\n]+)$/gm;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 'skill' | 'agent' | null: which kind of frontmatter file this path is. */
function kindOf(path) {
  if (basename(path) === 'SKILL.md') return 'skill';
  // agents/ inside a skill folder holds prompts the skill reads, not agent definitions
  if (extname(path) === '.md' && basename(dirname(path)) === 'agents' && !existsSync(join(dirname(dirname(path)), 'SKILL.md'))) return 'agent';
  return null;
}

const inspect = (v) => JSON.stringify(v);
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].trim();

/** The problems with a file's frontmatter, as sentences for the model; [] when it reads fine. */
function check(text, kind, yaml) {
  const m = FM.exec(text);
  if (!m) return ['no frontmatter: the file must open with a `---` block (nothing above it, not even a comment) and close it with `---`'];
  // Duplicate keys are not an error (`json: true`): the reader this mirrors takes the last one.
  const load = (s) => yaml.load(s, { json: true });
  // Claude Code reads an unquoted one-line value holding `: ` as a string, so that alone is no problem; a block that
  // fails even with every top-level one-line value quoted is broken for it too.
  const lenient = m[1].replace(ONE_LINE, (_, k, v) => `${k}: ${JSON.stringify(v.trim())}`);
  let fm;
  try {
    try { fm = load(m[1]); } catch { fm = load(lenient); }
  } catch (e) {
    return [`frontmatter is not valid YAML (${firstLine(e)})`];
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm) || Object.getPrototypeOf(fm) !== Object.prototype) {
    return ['frontmatter is not a key: value map'];
  }
  const problems = [];
  const { name, description: desc } = fm;
  if (desc == null || (typeof desc === 'string' && desc.trim() === '')) {
    problems.push('no `description`: it is the only text that decides when this fires');
  } else if (typeof desc !== 'string') {
    problems.push('`description` is not a string');
  } else if (kind === 'skill' && [...desc].length > 1024) {
    problems.push(`\`description\` is ${[...desc].length} characters, the limit is 1024 — cut the summary, keep the trigger`);
  }
  if (kind === 'agent' && name == null) problems.push('no `name`: an agent definition needs one');
  if (name != null && (typeof name !== 'string' || !NAME.test(name))) {
    problems.push(`\`name\` ${inspect(name)} must be lowercase letters, digits and hyphens, at most 64`);
  }
  return problems;
}

function pathFromStdin() {
  try {
    const p = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.file_path;
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

function main() {
  const path = process.argv[2] ?? pathFromStdin();
  if (typeof path !== 'string') return 0;
  const kind = kindOf(path);
  let isFile = false;
  try { isFile = kind !== null && statSync(path).isFile(); } catch { /* gone or unreadable: not ours */ }
  if (!isFile) return 0;
  const yaml = createRequire(import.meta.url)('./vendor/js-yaml.min.cjs');
  const problems = check(readFileSync(path, 'utf8'), kind, yaml);
  if (problems.length === 0) return 0;
  process.stderr.write(`${path}: frontmatter problems:\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
  return 2;
}

process.exitCode = main();
