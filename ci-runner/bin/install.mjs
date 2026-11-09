import { execFileSync } from 'node:child_process';
import { check, load } from './render.mjs';
import { validateHost } from './validate.mjs';

const FILES = ['compose.yaml', 'Dockerfile', 'entrypoint.sh'];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const display = (command, args) => [command, ...args.map(quote)].join(' ');

function execute(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024, ...options });
  } catch {
    // Never forward a child's stdout/stderr: the registration or Compose diagnostics may contain the token.
    throw new Error(`ci-runner install: ${command} failed; no further install steps were run`);
  }
}

function assertIdle(buffer) {
  let pages;
  try { pages = JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('ci-runner install: invalid runner listing from gh'); }
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((p) => !Array.isArray(p.runners)
    || p.runners.some((r) => typeof r?.name !== 'string' || typeof r?.busy !== 'boolean'))) {
    throw new Error('ci-runner install: incomplete runner listing from gh; refusing to install');
  }
  const busy = pages.flatMap((p) => p.runners).filter((r) => r.busy);
  if (busy.length) throw new Error(`ci-runner install: busy runners: ${busy.map((r) => r.name).join(', ')}; rerun when idle`);
}

function commands(config, host) {
  const endpoint = `repos/${config.repo}/actions/runners`;
  return {
    listing: ['api', '--paginate', '--slurp', endpoint],
    mkdir: [host, `install -d -m 700 -- ${quote(config.dir)}`],
    // Force legacy SCP so remote-shell quoting of directories with spaces is consistent across OpenSSH versions.
    // Relative sources + cwd also avoid scp treating a Windows drive letter as a remote hostname.
    copy: ['-O', '--', ...FILES.map((file) => `./${file}`), `${host}:${quote(`${config.dir}/`)}`],
    token: ['api', '-X', 'POST', `${endpoint}/registration-token`, '--jq', '.token'],
    start: [host, `cd ${quote(config.dir)} && RUNNER_TOKEN=$(cat) docker compose up -d --build --wait && docker compose ps`],
  };
}

export function install(root, { dryRun = false, env = process.env, run = execute, print = console.log } = {}) {
  const drift = check(root);
  if (drift.length) throw new Error(drift.join('\n'));
  const { config, directory } = load(root);
  const host = env.CI_RUNNER_HOST ?? config.host;
  validateHost(host);
  const plan = commands(config, host);
  if (dryRun) return printPlan(plan, directory, print);
  assertIdle(run('gh', plan.listing));
  run('ssh', plan.mkdir);
  run('scp', plan.copy, { cwd: directory });
  register(plan, run);
}

function printPlan(plan, directory, print) {
  print(`${display('gh', plan.listing)} # refuse if ANY repository runner is busy (all pages)`);
  print(display('ssh', plan.mkdir));
  print(`(cd ${quote(directory.replaceAll('\\', '/'))} && ${display('scp', plan.copy)})`);
  print(`${display('gh', plan.token)} | ${display('ssh', plan.start)}`);
}

function register(plan, run) {
  // Hold only this short-lived response in memory so a failed gh never starts Compose with partial/empty stdin.
  const token = run('gh', plan.token);
  let input;
  try {
    const value = token.toString('utf8');
    if (!/^[a-zA-Z0-9_\-]+\r?\n?$/.test(value) || ['null', 'true', 'false'].includes(value.trim())) {
      throw new Error('ci-runner install: invalid registration response');
    }
    input = Buffer.from(value.trim()); // Native Windows gh may end its response with CRLF.
    run('ssh', plan.start, { input, stdio: ['pipe', 'ignore', 'ignore'] });
  } finally {
    token.fill(0);
    input?.fill(0);
  }
}
