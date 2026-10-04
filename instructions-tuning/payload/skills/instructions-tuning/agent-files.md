# Agent files

A subagent definition (`.claude/agents/<name>.md`, `~/.claude/agents/<name>.md`) is frontmatter plus a body that
becomes the agent's system prompt in place of the default one. Two facts shape everything below: the agent sees only
that body and the prompt its caller wrote, and the caller sees only the agent's final report.

## The description routes work

The main model reads every agent's description on every turn to decide what to delegate, so it is a routing trigger,
not a summary: name the requests it takes in the words they arrive in, add "use proactively" when it should take work
nobody explicitly handed it, and close with "Not for X — that is Y", naming the neighbour it is most often confused
with. Check a change the way `skill-files.md` checks a skill description, against should-route prompts and near misses
read beside the neighbours' descriptions. Keep it short: every description is paid for on every turn.

## Frontmatter carries what the caller cannot

- `model` and `effort` go here. A caller can pass a model per call but never an effort, so an agent without `effort`
  inherits the session's, and a cheap reader runs as expensively as the main thread.
- `tools`: a short list for an agent that must not act — a reviewer that has no Edit reports the gap instead of
  "fixing" it. Omit it for an agent that builds, so it inherits everything.
- `hooks:` here are scoped to this agent and live only while it runs; a `Stop` hook runs as `SubagentStop` and can
  keep it working (exit 2, stderr becomes its next instruction). A user-level agent's hooks need no trust prompt;
  a plugin's agents ignore them.

## The body: goal, distrust, report

State the outcome and how the agent checks it, not a step script. Say what it must not take on trust — the caller's
summary of the code, a passing check it did not run — and where to look instead. Shape the report as labelled slots
(what changed, decisions made, check results, evidence as `path:line` or command output), because a slot left empty is
visible to the caller and a claim without evidence can be told apart.

## An agent that learns

`memory: user | project | local` gives the agent a folder (`~/.claude/agent-memory/<name>/`, or under the project's
`.claude/`) whose `MEMORY.md` — its first 200 lines — is in the agent's context on every run, with Read/Write/Edit
enabled for it. Pick the scope by who may read the lessons: `user` for private or cross-project ones, `project` when
the team should share them. Keep `MEMORY.md` an index of topic files; a lesson is the cause in one sentence and what to
do instead, replaced when a sharper one arrives.

Writing lessons must be mechanical, not a request in the body. The check script the agent has to run appends every
failure to an `inbox.md` in that folder, and a frontmatter `Stop` hook refuses to let the agent finish while the inbox
has lines — releasing it on `stop_hook_active`, so a second refusal never loops. Then cover the feedback that arrives
after the agent has finished: the owner's corrections land in another session, so a `UserPromptSubmit` hook that
appends messages naming the agent's subject to the same inbox, plus one line in the body that corrections passed in
its prompt are lessons too, closes that gap. Without it the agent learns only from what fails inside its own run.

## Verify with a real run

Give it one small real task and ask the report to show what it had: a quote of `MEMORY.md`'s first line proves the
memory loaded, the list of topic files it opened shows it used them. Read the transcript, not only the report.
