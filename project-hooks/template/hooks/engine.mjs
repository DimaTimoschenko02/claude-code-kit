// project-hooks engine: runs a project's hook table (../core/index.mjs) for one classic hook event.
// Pure JavaScript with no Node or engine API: every file and process access goes through the `io` a shell passes.
// Two shells call it with the same table: hooks/register.ts (a Claude Code mod, in the session's own process)
// and node/runner.mjs (one node process per event, for Codex). The contract is in hooks/contract.ts.
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.

/** Events whose matcher is tested against the tool name, as in settings.json. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

/** What an event's matcher is tested against, as settings.json does it. */
export function matchTarget(event, input) {
  if (TOOL_EVENTS.has(event)) return String(input.tool_name ?? '');
  if (event === 'SessionStart') return String(input.source ?? 'startup');
  if (event === 'SessionEnd') return String(input.reason ?? '');
  if (event === 'SubagentStart' || event === 'SubagentStop') return String(input.agent_type ?? '');
  if (event === 'PreCompact' || event === 'PostCompact') return String(input.trigger ?? '');
  if (event === 'Notification') return String(input.notification_type ?? '');
  return '';
}

/** Events the table has a hook for: each shell hooks exactly these. */
export function eventsOf(hooks) {
  return [...new Set(hooks.flatMap((h) => [h.event].flat()))];
}

/** The hooks of the table that apply to this event and input, in table order. */
export function select(hooks, event, input, { codex = false } = {}) {
  const target = matchTarget(event, input);
  return hooks.filter((h) => [h.event].flat().includes(event)
    && !(codex && h.codex === false)
    && (!h.matcher || h.matcher.test(target)));
}

/** A hook's answer as the classic output object a command hook prints; a string is additionalContext. */
export function normalize(event, out) {
  if (out === null || out === undefined || out === '') return null;
  if (typeof out === 'string') return { hookSpecificOutput: { hookEventName: event, additionalContext: out } };
  return typeof out === 'object' ? out : null;
}

/** A script's exit as a command hook's: exit 2 blocks with stderr, stdout is JSON or plain context text. */
export function scriptOutput(event, { exitCode, stdout, stderr }) {
  if (exitCode === 2) {
    const reason = String(stderr || stdout || '').trim() || 'Project hook blocked the operation';
    return event === 'PreToolUse'
      ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } }
      : { decision: 'block', reason };
  }
  if (exitCode !== 0) return null; // a non-blocking error, as for a command hook
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return normalize(event, JSON.parse(text));
  } catch {
    return normalize(event, text);
  }
}

const decisionOf = (out) => {
  const hso = out?.hookSpecificOutput ?? {};
  if (hso.permissionDecision) return { decision: hso.permissionDecision, reason: hso.permissionDecisionReason ?? '' };
  if (out?.decision === 'block' || out?.decision === 'deny') return { decision: 'deny', reason: out.reason ?? '' };
  if (out?.decision === 'approve') return { decision: 'allow', reason: out.reason ?? '' };
  return null;
};

/** True when this classic output ends a PreToolUse: later hooks of the table do not run. */
export const isDeny = (out) => decisionOf(out)?.decision === 'deny';

/** Many classic outputs of one event folded into one, as Claude Code folds several command hooks. */
export function fold(event, outputs) {
  const outs = outputs.filter(Boolean);
  if (!outs.length) return null;
  const contexts = outs.map((o) => o.hookSpecificOutput?.additionalContext).filter(Boolean);
  const messages = outs.map((o) => o.systemMessage).filter(Boolean);
  const hso = Object.assign({}, ...outs.map((o) => o.hookSpecificOutput ?? {}), { hookEventName: event });
  delete hso.additionalContext;
  delete hso.permissionDecision;
  delete hso.permissionDecisionReason;
  if (contexts.length) hso.additionalContext = contexts.join('\n\n');
  const folded = {};
  if (event === 'PreToolUse') {
    const decisions = outs.map(decisionOf).filter(Boolean);
    const pick = ['deny', 'ask', 'allow'].map((d) => decisions.find((x) => x.decision === d)).find(Boolean);
    if (pick) Object.assign(hso, { permissionDecision: pick.decision, permissionDecisionReason: pick.reason });
  } else {
    const blocks = outs.filter((o) => o.decision === 'block').map((o) => o.reason).filter(Boolean);
    if (blocks.length) Object.assign(folded, { decision: 'block', reason: blocks.join('\n\n') });
  }
  const stop = outs.find((o) => o.continue === false);
  if (stop) Object.assign(folded, { continue: false, stopReason: stop.stopReason ?? '' });
  if (messages.length) folded.systemMessage = messages.join('\n');
  if (Object.keys(hso).length > 1) folded.hookSpecificOutput = hso;
  return Object.keys(folded).length ? folded : null;
}

/** Fields of ClassicResult each event reads besides block / preventContinuation / stopReason (ClassicResultFields). */
const EVENT_FIELDS = {
  UserPromptSubmit: ['additionalContext', 'sessionTitle', 'suppressOriginalPrompt'],
  SessionStart: ['additionalContext', 'initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'],
  Setup: ['additionalContext'],
  SubagentStart: ['additionalContext'],
  PostToolUse: ['additionalContext', 'updatedToolOutput', 'updatedMCPToolOutput'],
  PostToolUseFailure: ['additionalContext'],
  PostToolBatch: ['additionalContext'],
  Stop: ['additionalContext'],
  SubagentStop: ['additionalContext'],
};

/**
 * A folded classic output as a mod's answer: for PreToolUse a PreToolUseResult part ({deny} / {ask} / {allow},
 * additionalContext, updatedInput), for any other event a ClassicResult part. null = nothing to add.
 */
export function toModResult(event, out) {
  if (!out) return null;
  const hso = out.hookSpecificOutput ?? {};
  const ctx = hso.additionalContext ? [String(hso.additionalContext)] : [];
  const result = {};
  if (event === 'PreToolUse') {
    const d = decisionOf(out);
    if (d?.decision === 'deny') result.deny = d.reason || 'Denied by a project hook';
    else if (d?.decision === 'ask') result.ask = d.reason || 'A project hook asks to confirm';
    else if (d?.decision === 'allow') result.allow = true;
    if (ctx.length) result.additionalContext = ctx;
    if (hso.updatedInput) result.updatedInput = hso.updatedInput;
    return Object.keys(result).length ? result : null;
  }
  if (out.decision === 'block') result.block = String(out.reason ?? '') || 'Blocked by a project hook';
  if (out.continue === false) Object.assign(result, { preventContinuation: true, stopReason: String(out.stopReason ?? '') });
  for (const field of EVENT_FIELDS[event] ?? []) {
    if (field === 'additionalContext') {
      if (ctx.length) result.additionalContext = ctx;
    } else if (hso[field] !== undefined) {
      result[field] = hso[field];
    }
  }
  return Object.keys(result).length ? result : null;
}

/** A mod answer (toModResult) laid over what the hooks beneath answered (`next(e)`). */
export function mergeModResult(beneath, ours) {
  if (!ours) return beneath;
  const merged = { ...(beneath ?? {}), ...ours };
  const ctx = [...(beneath?.additionalContext ?? []), ...(ours.additionalContext ?? [])];
  if (ctx.length) merged.additionalContext = ctx;
  if (beneath?.block && ours.block) merged.block = `${beneath.block}\n\n${ours.block}`;
  return merged;
}

/** `${root}` in a script's argv is the project root; a bare `bash` is the shell's own bash (Git Bash on Windows). */
async function argvOf(script, io) {
  const argv = script.map((a) => String(a).replaceAll('${root}', io.root));
  if (argv[0] === 'bash') argv[0] = await io.bash();
  return argv;
}

/** One hook of the table: its `when` gate, then its pure `run` or its `script`. Returns a classic output or null. */
export async function runHook(hook, event, input, io) {
  if (hook.when && !(await hook.when(input, io))) return null;
  if (hook.run) return normalize(event, await hook.run(input, io));
  if (!hook.script) return null;
  const result = await io.run(await argvOf(hook.script, io), {
    stdin: JSON.stringify(input),
    // CODEX_COMPAT: a script that predates the table still skips its own Codex-only parts, as under the old runtime.
    env: { CLAUDE_PROJECT_DIR: io.root, ...(io.codex ? { CODEX_COMPAT: '1' } : {}) },
    timeoutMs: hook.timeoutMs ?? 60000,
  });
  return scriptOutput(event, result);
}

/**
 * Every hook of the table for one event, folded into one classic output (null = nothing to say).
 * PreToolUse runs the hooks in table order and stops at the first deny; other events run them at once.
 * A hook that throws is skipped (fail-open) and reported through `io.log`.
 */
export async function runEvent(hooks, event, input, io) {
  const chosen = select(hooks, event, input, { codex: io.codex });
  const safe = async (hook) => {
    try {
      return await runHook(hook, event, input, io);
    } catch (error) {
      io.log(`${hook.name}: ${error?.message ?? error}`);
      return null;
    }
  };
  if (event !== 'PreToolUse') return fold(event, await Promise.all(chosen.map(safe)));
  const outs = [];
  for (const hook of chosen) {
    const out = await safe(hook);
    if (!out) continue;
    outs.push(out);
    if (isDeny(out)) break;
  }
  return fold(event, outs);
}

/** One spelling of a path: `C:\x`, `c:/x` and `/c/x` all become `C:/x` on Windows; other paths stay. */
export function normalPath(p, platform) {
  const s = String(p ?? '');
  if (platform !== 'win32') return s;
  let out = s.replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])(\/|$)/.exec(out);
  if (m) out = `${m[1]}:/${out.slice(3)}`;
  return out.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
}
