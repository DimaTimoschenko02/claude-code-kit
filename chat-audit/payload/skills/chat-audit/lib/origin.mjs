// chat-audit :: origin — who started a session: the user, or an agent / script on their behalf.
//
// An agent-launched session opens with the agent's brief written in the user role; read as the user's words it
// fakes statements, corrections and "the user's" work. Later turns in it can still be the user (they attach to a
// background session and talk), so only the opener is the agent's.
//
// Claude Code — read from the transcript itself, because job state (~/.claude/jobs) is removed with `claude rm`:
//   entrypoint sdk-* without origin.kind "human"   headless `claude -p` / SDK run                    → agent
//   agent-setting "claude"                          the agents view's default agent, opened by hand  → user
//   agent-setting <other>                           a named agent run (`--agent duty` from a timer)   → agent
//   agent-name without agent-setting                `claude --bg -n <name> "<prompt>"` from a command → agent
//   anything else                                   interactive terminal, IDE, phone / Remote Control → user
// Known miss: a user who types `claude --bg -n x "..."` in a terminal reads as agent.
//
// Codex — session_meta.payload: originator "codex_exec" is a prompt delegated by another session; a thread spawned
// by another thread (thread_source "subagent" / source.subagent) is a sub-agent; a thread an app thread opened with
// create_thread (thread_source "agent_created_thread") starts from that thread's brief, whatever its originator says.
// Phone, terminal and app threads the user opened are theirs.

import fs from 'node:fs';

export const UI_AGENT = 'claude';   // what the agents view starts when no agent name is typed

/** facts: { entrypoint, humanOrigin, agentSetting, agentName } from the first records of a Claude transcript. */
export function claudeLaunch({ entrypoint = null, humanOrigin = false, agentSetting = null, agentName = null } = {}) {
  if (/^sdk/.test(entrypoint || '') && !humanOrigin) return { by: 'agent', how: 'headless' };
  if (agentSetting) return agentSetting === UI_AGENT ? { by: 'user', how: 'agents-view' } : { by: 'agent', how: `agent=${agentSetting}` };
  if (agentName) return { by: 'agent', how: 'bg-command' };
  if (/^sdk/.test(entrypoint || '')) return { by: 'user', how: 'remote' };
  return { by: 'user', how: entrypoint || 'unknown' };
}

/** meta: session_meta.payload of a Codex rollout. */
export function codexLaunch(meta = {}) {
  const originator = meta?.originator || 'unknown';
  if (originator === 'codex_exec') return { by: 'agent', how: 'codex-exec' };
  if (meta?.thread_source === 'subagent' || (meta?.source && typeof meta.source === 'object' && meta.source.subagent)) return { by: 'agent', how: 'codex-subagent' };
  if (meta?.thread_source === 'agent_created_thread') return { by: 'agent', how: 'codex-thread' };
  return { by: 'user', how: originator };
}

/** Feed parsed Claude records in order (the head is enough); `facts` is then ready for claudeLaunch. */
export function claudeFactsCollector() {
  const facts = { entrypoint: null, humanOrigin: false, agentSetting: null, agentName: null };
  return {
    facts,
    take(o) {
      if (o.type === 'agent-setting' && o.agentSetting) facts.agentSetting = o.agentSetting;
      else if (o.type === 'agent-name' && o.agentName) facts.agentName ??= o.agentName;
      else if (o.type === 'user') {
        facts.entrypoint ??= o.entrypoint || null;
        // any human-labelled turn: a meta record can come first and carries no origin
        if (o.origin?.kind === 'human') facts.humanOrigin = true;
      }
    },
  };
}

/** claudeLaunch from the head of a transcript: the launch records come before the first reply. */
export function claudeLaunchOfFile(file, headBytes = 262144) {
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(headBytes);
    text = buf.subarray(0, fs.readSync(fd, buf, 0, headBytes, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
  const col = claudeFactsCollector();
  for (const line of text.split('\n')) {
    if (!/"type":"(user|agent-setting|agent-name)"/.test(line.slice(0, 400)) && !line.includes('"type":"user"')) continue;
    try { col.take(JSON.parse(line)); } catch { /* the cut last line */ }
  }
  return claudeLaunch(col.facts);
}
