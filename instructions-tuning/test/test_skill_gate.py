"""skill-gate-guard.sh — when a compaction resets a loaded skill.

After a compaction Claude Code re-attaches every invoked skill's text (attachment `invoked_skills`, cut at 20 000
chars). The gate counted every compaction as a reset and bounced the first governed write after it: 31 times in 4
sessions, 06–11.10, each time the session re-loaded a skill that was still in context and resent the write.
Run from the kit root: python3 -B -m unittest discover -s instructions-tuning/test
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HOOKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "payload", "hooks")
# SKILL_GATE_IMPL=node runs the same cases against the node port (skill-gate-guard.mjs).
GATE_CMD = (["node", os.path.join(HOOKS, "skill-gate-guard.mjs")] if os.environ.get("SKILL_GATE_IMPL") == "node"
            else [shutil.which("bash") or "bash", os.path.join(HOOKS, "skill-gate-guard.sh")])
SID = "s-1"


def entry(ts, **kw):
    return json.dumps({"timestamp": ts, **kw}, separators=(",", ":"))


def compact(ts):
    return entry(ts, type="user", isCompactSummary=True, message={"content": "summary"})


def skills(ts, *named):
    return entry(ts, type="attachment",
                 attachment={"type": "invoked_skills", "skills": [{"name": n, "content": "x" * size} for n, size in named]})


class Gate(unittest.TestCase):
    def run_gate(self, transcript_lines, invocations, agent_id=None, agent_type=None, agents=None,
                 agent_lines=(), agent_invocations=(), agent_file=True, codex=False):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, ".claude", "state"))
            os.makedirs(os.path.join(root, ".claude", "agents"))
            for fname, fm in (agents or {}).items():
                with open(os.path.join(root, ".claude", "agents", fname), "w") as f:
                    f.write("---\n" + fm + "\n---\n\nbody\n")
            with open(os.path.join(root, ".claude", "skill-gate.config.json"), "w") as f:
                json.dump({"gates": [{"path_prefix": "brain/", "skill": "vault-write"}]}, f)
            with open(os.path.join(root, ".claude", "state", "skill-invocations.jsonl"), "w") as f:
                for ts in invocations:
                    f.write(json.dumps({"skill": "vault-write", "ts": ts, "session_id": SID}) + "\n")
                for ts in agent_invocations:
                    f.write(json.dumps({"skill": "vault-write", "ts": ts, "session_id": SID, "agent_id": agent_id}) + "\n")
            transcript = os.path.join(root, SID + ".jsonl")
            with open(transcript, "w") as f:
                f.write("\n".join([entry("2026-10-11T10:00:00.000Z", type="user")] + transcript_lines) + "\n")
            if agent_id and agent_file:
                # Claude Code's layout: <project-dir>/<session_id>/subagents/agent-<agent_id>.jsonl
                sub = os.path.join(root, SID, "subagents")
                os.makedirs(sub)
                with open(os.path.join(sub, "agent-" + agent_id + ".jsonl"), "w") as f:
                    f.write("\n".join([entry("2026-10-11T10:30:00.000Z", type="user")] + list(agent_lines)) + "\n")
            payload = {"tool_name": "Write", "tool_input": {"file_path": os.path.join(root, "brain", "n.md")},
                       "transcript_path": transcript, "cwd": root, "session_id": SID}
            if agent_id:
                payload["agent_id"] = agent_id
            if agent_type:
                payload["agent_type"] = agent_type
            env = {k: v for k, v in os.environ.items()
                   if k not in ("CLAUDE_PROJECT_DIR", "SKILL_GATE_LOG", "CODEX_COMPAT")}
            env["HOME"] = root
            if codex:
                env["CODEX_COMPAT"] = "1"
            return subprocess.run(GATE_CMD, input=json.dumps(payload), capture_output=True, text=True,
                                  env=env).returncode

    def test_skill_loaded_after_compaction_passes(self):
        self.assertEqual(self.run_gate([compact("2026-10-11T12:00:00.000Z")], ["2026-10-11T12:05:00.000Z"]), 0)

    def test_compaction_without_reattachment_still_resets(self):
        self.assertEqual(self.run_gate([compact("2026-10-11T12:00:00.000Z")], ["2026-10-11T11:00:00.000Z"]), 2)

    def test_reattached_whole_after_compaction_passes(self):
        lines = [compact("2026-10-11T12:00:00.000Z"), skills("2026-10-11T12:00:00.000Z", ("vault-write", 1083))]
        self.assertEqual(self.run_gate(lines, ["2026-10-11T11:00:00.000Z"]), 0)

    def test_reattached_under_scoped_name_passes(self):
        lines = [compact("2026-10-11T12:00:00.000Z"),
                 skills("2026-10-11T12:00:00.000Z", ("pricehub:vault-write", 1092))]
        self.assertEqual(self.run_gate(lines, ["2026-10-11T11:00:00.000Z"]), 0)

    def test_reattached_cut_at_the_limit_resets(self):
        lines = [compact("2026-10-11T12:00:00.000Z"), skills("2026-10-11T12:00:00.000Z", ("vault-write", 20000))]
        self.assertEqual(self.run_gate(lines, ["2026-10-11T11:00:00.000Z"]), 2)

    def test_attachment_from_an_earlier_compaction_does_not_count(self):
        lines = [compact("2026-10-11T11:30:00.000Z"), skills("2026-10-11T11:30:00.000Z", ("vault-write", 1083)),
                 compact("2026-10-11T12:00:00.000Z")]
        self.assertEqual(self.run_gate(lines, ["2026-10-11T11:00:00.000Z"]), 2)

    def test_subagent_does_not_inherit_the_main_attachment(self):
        lines = [compact("2026-10-11T12:00:00.000Z"), skills("2026-10-11T12:00:00.000Z", ("vault-write", 1083))]
        self.assertEqual(self.run_gate(lines, [], agent_id="a-1"), 2)


    # A subagent whose definition preloads the skill (`skills:`) has its text from the start; no Skill call is logged.
    def test_subagent_with_the_skill_preloaded_passes(self):
        agents = {"coder.md": "name: coder\nmodel: opus\nskills:\n  - vault-write"}
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_type="coder", agents=agents), 0)

    def test_preload_inline_list_and_scoped_name_pass(self):
        agents = {"x.md": "name: coder\nskills: [pricehub:vault-write, other]"}
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_type="coder", agents=agents), 0)

    def test_codex_agent_definition_does_not_prove_a_skill_was_loaded(self):
        for declaration in ("skills:\n  - vault-write", "skills: [pricehub:vault-write, other]"):
            with self.subTest(declaration=declaration):
                agents = {"coder.md": "name: coder\n" + declaration}
                self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_type="coder",
                                               agents=agents, codex=True), 2)

    def test_codex_agent_passes_after_its_verified_skill_read(self):
        agents = {"coder.md": "name: coder\nskills:\n  - vault-write"}
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_type="coder", agents=agents,
                                       agent_invocations=["2026-10-11T11:00:00.000Z"], codex=True), 0)

    def test_codex_agent_cannot_use_its_parents_skill_read(self):
        agents = {"coder.md": "name: coder\nskills:\n  - vault-write"}
        self.assertEqual(self.run_gate([], ["2026-10-11T11:00:00.000Z"], agent_id="a-1",
                                       agent_type="coder", agents=agents, codex=True), 2)

    def test_subagent_preloading_another_skill_is_denied(self):
        agents = {"coder.md": "name: coder\nskills:\n  - code-style"}
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_type="coder", agents=agents), 2)

    def test_preload_is_found_by_name_not_by_another_agent(self):
        agents = {"reader.md": "name: reader\nskills:\n  - vault-write", "coder.md": "name: coder"}
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_type="coder", agents=agents), 2)


    # Inside a subagent `transcript_path` is the parent's transcript. The parent's compaction left the subagent's context
    # alone, yet the gate re-locked it: 41 of 51 coder blocks, 09–23.10, hit a coder that had loaded the skill.
    def test_parent_compaction_does_not_reset_a_subagent(self):
        self.assertEqual(self.run_gate([compact("2026-10-11T12:00:00.000Z")], [], agent_id="a-1",
                                       agent_invocations=["2026-10-11T11:00:00.000Z"]), 0)

    def test_subagent_own_compaction_resets(self):
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_lines=[compact("2026-10-11T12:00:00.000Z")],
                                       agent_invocations=["2026-10-11T11:00:00.000Z"]), 2)

    def test_subagent_own_reattachment_passes(self):
        lines = [compact("2026-10-11T12:00:00.000Z"), skills("2026-10-11T12:00:00.000Z", ("vault-write", 1083))]
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_lines=lines,
                                       agent_invocations=["2026-10-11T11:00:00.000Z"]), 0)

    def test_subagent_load_before_its_start_does_not_count(self):
        self.assertEqual(self.run_gate([], [], agent_id="a-1", agent_invocations=["2026-10-11T10:10:00.000Z"]), 2)

    def test_subagent_without_its_transcript_fails_open(self):
        self.assertEqual(self.run_gate([compact("2026-10-11T12:00:00.000Z")], [], agent_id="a-1", agent_file=False), 0)


if __name__ == "__main__":
    unittest.main()
