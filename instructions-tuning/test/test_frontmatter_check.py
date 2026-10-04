"""frontmatter-check.rb — the instructions-tuning skill's PostToolUse hook on SKILL.md and agent definitions.

Cases are what the first sweep over real skills and agents found: an installer marker comment above `---` (the skill
never lists), an unquoted `: ` in a one-line description (Claude Code reads it, so no finding), prompt files under a
skill's own `agents/` (not agent definitions), and descriptions over 1024 on a skill versus an agent.
Run from the kit root: python3 -B -m unittest discover -s instructions-tuning/test
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "payload", "skills", "instructions-tuning",
                      "scripts", "frontmatter-check.rb")


@unittest.skipUnless(shutil.which("ruby"), "ruby not installed")
class FrontmatterCheck(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def run_hook(self, path):
        payload = json.dumps({"tool_name": "Edit", "tool_input": {"file_path": path}})
        return subprocess.run(["ruby", SCRIPT], input=payload, capture_output=True, text=True)

    def test_good_skill_passes(self):
        p = self.write("skills/demo/SKILL.md", "---\nname: demo\ndescription: Use when the user asks for a demo.\n---\nbody\n")
        self.assertEqual(self.run_hook(p).returncode, 0)

    def test_marker_comment_above_frontmatter_fails(self):
        p = self.write("skills/demo/SKILL.md",
                       "<!-- managed -->\n---\nname: demo\ndescription: Use when asked.\n---\nbody\n")
        r = self.run_hook(p)
        self.assertEqual(r.returncode, 2)
        self.assertIn("no frontmatter", r.stderr)

    def test_unquoted_colon_in_description_passes(self):
        p = self.write("agents/builder.md",
                       "---\nname: builder\ndescription: Builds mods, above all mid-task: hand it the words.\n"
                       "model: opus\n---\nbody\n")
        self.assertEqual(self.run_hook(p).returncode, 0, self.run_hook(p).stderr)

    def test_broken_hooks_block_fails(self):
        p = self.write("agents/builder.md",
                       "---\nname: builder\ndescription: Builds mods.\nhooks:\n  Stop:\n   - hooks:\n  - type: x\n---\n")
        r = self.run_hook(p)
        self.assertEqual(r.returncode, 2)
        self.assertIn("not valid YAML", r.stderr)

    def test_agent_without_description_and_bad_name_fails(self):
        p = self.write("agents/x.md", "---\nname: Bad Name\n---\nbody\n")
        r = self.run_hook(p)
        self.assertEqual(r.returncode, 2)
        self.assertIn("no `description`", r.stderr)
        self.assertIn("lowercase", r.stderr)

    def test_long_description_fails_on_skill_only(self):
        long = "Use when " + "x" * 1100
        skill = self.write("skills/demo/SKILL.md", f"---\nname: demo\ndescription: {long}\n---\n")
        agent = self.write("agents/demo.md", f"---\nname: demo\ndescription: {long}\n---\n")
        self.assertEqual(self.run_hook(skill).returncode, 2)
        self.assertEqual(self.run_hook(agent).returncode, 0)

    def test_prompt_file_under_skill_agents_dir_is_skipped(self):
        self.write("skills/creator/SKILL.md", "---\nname: creator\ndescription: Use when.\n---\n")
        p = self.write("skills/creator/agents/grader.md", "# Grader\nNo frontmatter here.\n")
        self.assertEqual(self.run_hook(p).returncode, 0)

    def test_other_files_exit_at_once(self):
        p = self.write("notes/readme.md", "no frontmatter\n")
        self.assertEqual(self.run_hook(p).returncode, 0)
        r = subprocess.run(["ruby", SCRIPT], input="not json", capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
