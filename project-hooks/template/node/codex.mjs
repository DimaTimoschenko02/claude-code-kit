// project-hooks, the Codex side: a Codex hook payload as the classic Claude Code input the table's checks read, and
// the folded answer as what Codex accepts. Codex sends its native hooks (<repo>/.codex/hooks.json) Claude-shaped
// payloads, but names its own tools: a shell call can be exec_command or shell, a file edit is one apply_patch that
// may touch several files. Pure: no Node API, so the engine's tests cover it.
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command', 'shell']);
const PATCH_OPS = ['*** Add File: ', '*** Update File: ', '*** Delete File: '];

const isAbsolute = (p) => /^([A-Za-z]:)?[\\/]/.test(p);
const joinPath = (dir, p) => (isAbsolute(p) || !dir ? p : `${String(dir).replace(/[\\/]+$/, '')}/${p}`);
const quoteArg = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'"'"'`)}'`);

function shellInput(raw, args) {
  const command = args.command ?? args.cmd ?? '';
  const input = { ...raw, tool_name: 'Bash', tool_input: { command: Array.isArray(command) ? command.map(quoteArg).join(' ') : String(command) } };
  if (args.workdir) input.cwd = String(args.workdir);
  const response = raw.tool_response;
  if (typeof response === 'string') input.tool_response = { stdout: response, stderr: '' };
  else if (response && typeof response === 'object' && 'output' in response) {
    input.tool_response = { ...response, stdout: response.output, stderr: response.stderr ?? '' };
  }
  return input;
}

/** One Write or Edit input per file an apply_patch touches; `content` / `old_string` / `new_string` from its lines. */
function patchInputs(raw, args) {
  const patch = typeof args === 'string' ? args : String(args.command ?? args.patch ?? args.input ?? '');
  const cwd = String(raw.cwd ?? '');
  const inputs = [];
  let current = null;
  for (const line of patch.split(/\r?\n/)) {
    const op = PATCH_OPS.find((o) => line.startsWith(o));
    if (op) {
      current = { file_path: joinPath(cwd, line.slice(op.length).trim()), old_string: '', new_string: '' };
      inputs.push({ ...raw, tool_name: op === '*** Add File: ' ? 'Write' : 'Edit', tool_input: current });
    } else if (current && line.startsWith('*** Move to: ')) {
      inputs.push({ ...raw, tool_name: 'Edit', tool_input: { file_path: joinPath(cwd, line.slice(13).trim()) } });
    } else if (current && line.startsWith('+')) {
      current.new_string += `${line.slice(1)}\n`;
    } else if (current && line.startsWith('-')) {
      current.old_string += `${line.slice(1)}\n`;
    }
  }
  for (const input of inputs) {
    if (input.tool_name !== 'Write') continue;
    const { new_string: content, file_path: filePath } = input.tool_input;
    input.tool_input = { file_path: filePath, content };
  }
  return inputs;
}

/** The classic inputs a Codex tool event stands for: one per file of a patch, else one. */
export function claudeInputs(raw) {
  const name = String(raw.tool_name ?? '');
  const args = raw.tool_input ?? {};
  if (name === 'apply_patch') {
    const inputs = patchInputs(raw, args);
    return inputs.length ? inputs : [raw];
  }
  if (typeof args !== 'object' || args === null) return [raw];
  if (SHELL_TOOLS.has(name)) return [shellInput(raw, args)];
  if (name.endsWith('__write_file') && args.path) {
    return [{ ...raw, tool_name: 'Write', tool_input: { file_path: args.path, content: args.content ?? '' } }];
  }
  if (name.endsWith('__edit_file') && args.path) {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return [{ ...raw, tool_name: 'Edit', tool_input: {
      file_path: args.path,
      old_string: edits.map((e) => e?.oldText ?? '').join('\n'),
      new_string: edits.map((e) => e?.newText ?? '').join('\n'),
    } }];
  }
  if (name === 'spawn_agent') {
    return [{ ...raw, tool_name: 'Agent', tool_input: {
      subagent_type: args.agent_type ?? args.task_name ?? 'general-purpose',
      description: args.description ?? args.task_name ?? 'Codex agent',
      prompt: args.prompt ?? args.message ?? '',
    } }];
  }
  return [raw];
}

/**
 * A folded classic answer as Codex takes it. Codex has no PreToolUse `ask`, so an ask denies with its reason;
 * an input rewrite goes back only for a shell call, in the key the call used (a patch cannot be rewritten).
 */
export function codexOutput(event, out, raw) {
  if (!out || event !== 'PreToolUse') return out;
  const hso = { ...(out.hookSpecificOutput ?? {}) };
  if (hso.permissionDecision === 'ask') {
    hso.permissionDecision = 'deny';
    hso.permissionDecisionReason = `Needs the owner's confirmation, which Codex cannot ask for: ${hso.permissionDecisionReason ?? ''}`.trim();
  }
  if (hso.updatedInput) {
    const name = String(raw.tool_name ?? '');
    const original = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    if (SHELL_TOOLS.has(name) && typeof hso.updatedInput.command === 'string') {
      const key = 'cmd' in original && !('command' in original) ? 'cmd' : 'command';
      hso.updatedInput = { ...original, [key]: hso.updatedInput.command };
    } else if (name !== 'Bash' && claudeInputs(raw)[0] !== raw) {
      delete hso.updatedInput;
    }
  }
  return { ...out, hookSpecificOutput: hso };
}

/** Events whose input names a tool: these are the ones claudeInputs translates. */
export const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
