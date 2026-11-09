#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, render } from './render.mjs';
import { install } from './install.mjs';

export { check, render } from './render.mjs';
export { install } from './install.mjs';

function main(args) {
  const [command, root, ...flags] = args;
  if (!['render', 'check', 'install'].includes(command) || !root || root.startsWith('--')
    || flags.some((f) => f !== '--dry-run') || flags.length > 1 || (flags.length && command !== 'install')) {
    throw new Error('usage: node ci-runner/bin/ci-runner.mjs render|check|install <project-root> [--dry-run (install only)]');
  }
  if (command === 'install') return install(root, { dryRun: flags.includes('--dry-run') });
  if (command === 'render') return console.log(`Rendered: ${render(root).join(', ')}`);
  const errors = check(root);
  errors.forEach((error) => console.error(error));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
