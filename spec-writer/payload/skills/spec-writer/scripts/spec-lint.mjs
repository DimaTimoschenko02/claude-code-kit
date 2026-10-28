#!/usr/bin/env node
// spec-lint — checks a task spec against the spec-writer contract: every required section present and filled, no
// placeholder lines, every acceptance line and every «where it bites» line naming its test, a sane length.
//
//   node spec-lint.mjs <spec.md> [--json]     report; exit 1 when there are errors
//   node spec-lint.mjs --hook                 PostToolUse(Write|Edit) payload on stdin → a block decision on errors
//
// The project's `.claude/spec-writer.project.md` (nearest above the spec) gives the language, the glob of spec files
// and extra sections. A file outside the glob, or a project without that file, is not a spec: the hook stays silent.
// Sections, placeholders and limits come from ../sections.json, the one source the templates also follow.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, '..', 'sections.json'), 'utf8'));

const MSG = {
  ru: {
    missing: (h) => `нет раздела «## ${h}»`,
    empty: (h) => `раздел «${h}» не заполнен`,
    noAcceptance: (l) => `в «Приёмке» нет строк вида «- **${l}1** — … → \`тест\`»`,
    noCheck: (id) => `${id}: нет теста или команды (\`…\` после →)`,
    biteNoTest: (line) => `«Где укусит»: у строки «${line}» нет теста в \`…\``,
    placeholder: (p, line) => `заглушка «${p}»: «${line}»`,
    long: (n, max) => `${n} строк — длиннее ${max}: спека длиннее кода или задачу пора делить`,
    noCode: 'в «Решениях» нет ни одного блока кода — сигнатуры и главный запрос пишутся кодом',
    head: (n) => {
      const w = n % 10 === 1 && n % 100 !== 11 ? 'ошибка'
        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'ошибки' : 'ошибок';
      return `spec-lint: ${n} ${w} в спеке — поправь до передачи кодеру`;
    },
    more: (n) => `… и ещё ${n}`,
  },
  en: {
    missing: (h) => `missing section «## ${h}»`,
    empty: (h) => `section «${h}» is not filled`,
    noAcceptance: (l) => `«Acceptance» has no lines like «- **${l}1** — … → \`test\`»`,
    noCheck: (id) => `${id}: no test or command (\`…\` after →)`,
    biteNoTest: (line) => `«Where it bites»: «${line}» names no test in \`…\``,
    placeholder: (p, line) => `placeholder «${p}»: «${line}»`,
    long: (n, max) => `${n} lines — over ${max}: the spec is longer than its code or the task should split`,
    noCode: '«Decisions» has no code block — signatures and the main query are written as code',
    head: (n) => `spec-lint: ${n} error${n === 1 ? '' : 's'} in the spec — fix before handing it to a coder`,
    more: (n) => `… and ${n} more`,
  },
};

export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = {};
  if (!m) return { fields, body: text };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/(^|\s)#.*$/, '').replace(/^["']|["']$/g, '').trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

export function findProject(specPath) {
  let dir = dirname(resolve(specPath));
  for (;;) {
    const file = join(dir, '.claude', 'spec-writer.project.md');
    if (existsSync(file)) return { root: dir, file, ...parseProject(readFileSync(file, 'utf8')) };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function parseProject(text) {
  const { fields } = frontmatter(text);
  return {
    language: fields.language === 'ru' ? 'ru' : 'en',
    specGlob: fields.spec_glob || '**/*-spec.md',
    extraSections: (fields.extra_sections || '').split(',').map((s) => s.trim()).filter(Boolean),
    splitLines: Number(fields.split_lines) || 400,
  };
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Lines outside fenced code, with inline code removed — headings and placeholders are read from prose only.
function proseLines(body) {
  const out = [];
  let fence = false;
  for (const [i, line] of body.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push({ i, line: '', raw: line, code: true }); continue; }
    out.push({ i, line: fence ? '' : line.replace(/`[^`]*`/g, '``'), raw: line, code: fence });
  }
  return out;
}

const isTemplateHint = (l) => /^\s*<[^>]*>\s*$/.test(l) || /^\s*\|?\s*<[^>]*>\s*\|/.test(l);

export function lint(text, { language = 'en', extraSections = [] } = {}) {
  const msg = MSG[language];
  const { fields, body } = frontmatter(text);
  const form = fields.form === 'short' ? 'short' : 'full';
  const lines = proseLines(body);
  const errors = [];
  const warnings = [];

  // Split into sections by `## ` headings outside code.
  const sections = new Map();
  let current = null;
  for (const l of lines) {
    const h = !l.code && l.line.match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1]; sections.set(current, []); continue; }
    if (current) sections.get(current).push(l);
  }

  const required = CFG.sections.filter((s) => s.forms.includes(form));
  const titles = [...required.map((s) => ({ ...s, title: s[language] })),
    ...(form === 'full' ? extraSections.map((t) => ({ key: 'extra', title: t })) : [])];

  for (const s of titles) {
    const content = sections.get(s.title);
    if (!content) { errors.push(msg.missing(s.title)); continue; }
    const filled = content.filter((l) => l.raw.trim() && !isTemplateHint(l.raw));
    if (!filled.length && !s.mayBeEmpty) { errors.push(msg.empty(s.title)); continue; }

    if (s.items === 'numbered-with-check') {
      const label = CFG.acceptanceLabel[language];
      const rows = content.filter((l) => new RegExp(`^\\s*[-*]\\s+\\*\\*${label}\\d+\\*\\*`).test(l.raw));
      if (!rows.length) errors.push(msg.noAcceptance(label));
      for (const r of rows) {
        const id = r.raw.match(new RegExp(`${label}\\d+`))[0];
        const after = r.raw.split('→').slice(1).join('→');
        if (!/`[^`]+`/.test(after)) errors.push(msg.noCheck(id));
      }
    }
    if (s.items === 'bullets-with-check') {
      for (const r of content.filter((l) => /^\s*[-*]\s+/.test(l.raw) && !isTemplateHint(l.raw.replace(/^\s*[-*]\s+/, '')))) {
        if (!/`[^`]+`/.test(r.raw)) errors.push(msg.biteNoTest(r.raw.replace(/^\s*[-*]\s+/, '').slice(0, 60)));
      }
    }
    if (s.key === 'decisions' && !content.some((l) => l.code)) warnings.push(msg.noCode);
  }

  const silence = CFG.sections.find((s) => s.key === 'silence')[language];
  const deviations = CFG.sections.find((s) => s.key === 'deviations')[language];
  const ph = new RegExp(`(^|[^\\p{L}\\p{N}])(${CFG.placeholders[language].join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  let where = null;
  for (const l of lines) {
    const h = !l.code && l.line.match(/^##\s+(.+?)\s*$/);
    if (h) { where = h[1]; continue; }
    if (l.code || where === silence || where === deviations) continue;
    const m = l.line.match(ph);
    if (m) errors.push(msg.placeholder(m[2], l.raw.trim().slice(0, 70)));
  }

  const n = text.split('\n').length;
  if (n > CFG.maxLines) warnings.push(msg.long(n, CFG.maxLines));
  return { form, errors, warnings };
}

function runFile(path, json) {
  const project = findProject(path);
  const res = lint(readFileSync(path, 'utf8'), project ?? {});
  if (json) console.log(JSON.stringify(res, null, 2));
  else {
    for (const e of res.errors) console.log(`✗ ${e}`);
    for (const w of res.warnings) console.log(`△ ${w}`);
    if (!res.errors.length && !res.warnings.length) console.log('✓ spec-lint: ok');
  }
  process.exit(res.errors.length ? 1 : 0);
}

function runHook() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const path = payload?.tool_input?.file_path;
  if (!path || !/\.md$/.test(path) || !existsSync(path)) return;
  const project = findProject(path);
  if (!project) return;
  const rel = relative(project.root, resolve(path));
  // A worktree under the project root keeps its own relative layout: match the path's tail too.
  const re = globToRegExp(project.specGlob);
  const parts = rel.split('/');
  if (!parts.some((_, i) => re.test(parts.slice(i).join('/')))) return;
  const res = lint(readFileSync(path, 'utf8'), project);
  if (!res.errors.length) return;
  const msg = MSG[project.language];
  const shown = res.errors.slice(0, 5).map((e) => `- ${e}`);
  if (res.errors.length > 5) shown.push(msg.more(res.errors.length - 5));
  const reason = [msg.head(res.errors.length), ...shown, `node ${join(HERE, 'spec-lint.mjs')} ${path}`].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

// Compare real paths: an install with --link runs this file through a symlink, and argv[1] keeps the link's path.
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === '--hook') runHook();
  else if (args[0]) runFile(args[0], args.includes('--json'));
  else { console.error('usage: spec-lint.mjs <spec.md> [--json] | --hook'); process.exit(2); }
}
