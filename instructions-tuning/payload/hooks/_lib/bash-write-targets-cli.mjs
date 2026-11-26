#!/usr/bin/env node
// CLI of bash-write-targets.mjs, the same contract as bash-write-targets.py: command on stdin, argv[2] = cwd, one
// absolute target per line. For tests (BWT_IMPL=node) and callers that are not JS; a JS hook imports the function.
//   node bash-write-targets-cli.mjs <cwd> < command        node bash-write-targets-cli.mjs --batch < [[cmd, cwd], …]
// --batch answers a JSON array of [command, cwd] with a JSON array of target lists (null where the engine threw), in one
// process — the parity pass over real transcripts runs hundreds of commands.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { bashWriteTargets } from './bash-write-targets.mjs';

const input = readFileSync(0, 'utf8');
const opts = { env: process.env, home: homedir() }; // = os.environ and os.path.expanduser("~") of the .py
if (process.argv[2] === '--batch') {
  const out = JSON.parse(input).map(([command, cwd]) => {
    try {
      return bashWriteTargets(command, cwd, opts);
    } catch {
      return null;
    }
  });
  process.stdout.write(JSON.stringify(out));
} else {
  // Python's stdin on Windows reads "\r\n" and "\r" as "\n"; the CLIs read the same command alike.
  const command = process.platform === 'win32' ? input.replace(/\r\n?/g, '\n') : input;
  try {
    for (const p of bashWriteTargets(command, process.argv[2] ?? process.cwd(), opts)) process.stdout.write(`${p}\n`);
  } catch (e) {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
