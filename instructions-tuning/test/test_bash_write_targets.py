"""bash-write-targets.py — which files a Bash command writes, as the skill gate sees them.

Cases are the gate's real catches and misfires: a python heredoc writing a TSV whose rows quoted a hook path was denied
as an edit of that hook (every quoted path in a writing heredoc counted); `cd brain && python3 - <<EOF` writing a
relative card path is the catch the heredoc scan exists for.
Run from the kit root: python3 -B -m unittest discover -s instructions-tuning/test
"""
import os
import subprocess
import sys
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "payload", "hooks", "_lib",
                      "bash-write-targets.py")


def targets(cmd, cwd="/w"):
    out = subprocess.run([sys.executable, "-B", SCRIPT, cwd], input=cmd, capture_output=True, text=True, check=True)
    return out.stdout.splitlines()


def py(body, opener="python3 - <<'EOF'"):
    return f"{opener}\n{body}\nEOF"


def node(body):
    return f"node <<'EOF'\n{body}\nEOF"


class HeredocWriteCall(unittest.TestCase):
    """Rule 1: a path literal in a statement that makes a write call."""

    def test_python_open_for_write(self):
        self.assertEqual(targets(py("open('/v/x.md', 'w').write(s)")), ["/v/x.md"])

    def test_python_write_text(self):
        self.assertEqual(targets(py("from pathlib import Path\nPath('/v/x.md').write_text(s)")), ["/v/x.md"])

    def test_python_os_remove(self):
        self.assertEqual(targets(py("import os\nos.remove('/v/x')")), ["/v/x"])

    def test_python_shutil_move(self):
        self.assertEqual(targets(py("import shutil\nshutil.move('/a', '/b')")), ["/a", "/b"])

    def test_node_write_file_sync(self):
        self.assertEqual(targets(node("const fs = require('fs');\nfs.writeFileSync('/v/x.md', s);")), ["/v/x.md"])

    def test_open_call_split_over_lines(self):
        body = "with open(\n    '/v/x.md', 'w') as f:\n    f.write(s)"
        self.assertEqual(targets(py(body)), ["/v/x.md"])

    def test_open_of_a_joined_path(self):
        body = "import os\nwith open(os.path.join('/v', 'x.md'), 'w') as f:\n    f.write(s)"
        self.assertEqual(targets(py(body)), ["/v/x.md"])

    def test_relative_path_resolves_against_the_heredoc_directory(self):
        cmd = py("open('tasks/PH-1.md', 'w').write(s)", opener="cd brain && python3 - <<'EOF'")
        self.assertEqual(targets(cmd, cwd="/w"), ["/w/brain/tasks/PH-1.md"])


class HeredocAssignedPath(unittest.TestCase):
    """Rule 2: a path assigned to a name that a write statement uses."""

    def test_python_plain_literal(self):
        self.assertEqual(targets(py("p = '/v/x.md'\nopen(p, 'w').write(s)")), ["/v/x.md"])

    def test_python_path_object(self):
        self.assertEqual(targets(py("from pathlib import Path\np = Path('/v/x.md')\np.write_text(s)")), ["/v/x.md"])

    def test_python_os_path_join(self):
        body = "import os\np = os.path.join('/v', 'x.md')\nwith open(p, 'w') as f:\n    f.write(s)"
        self.assertEqual(targets(py(body)), ["/v/x.md"])

    def test_python_expanduser(self):
        body = "import os\np = os.path.expanduser('~/x.md')\nopen(p, 'a').write(s)"
        self.assertEqual(targets(py(body)), [os.path.expanduser("~/x.md")])

    def test_node_const_path_join(self):
        body = "const fs = require('fs'), path = require('path');\nconst p = path.join('/v', 'x.md');\n" \
               "fs.writeFileSync(p, s);"
        self.assertEqual(targets(node(body)), ["/v/x.md"])

    def test_node_let_and_var(self):
        body = "let p = '/v/a.md';\nvar q = '/v/b.md';\nfs.appendFileSync(p, s);\nfs.writeFileSync(q, s);"
        self.assertEqual(targets(node(body)), ["/v/a.md", "/v/b.md"])


class HeredocPythonBindings(unittest.TestCase):
    """The edit shapes past sessions used most: a replace helper, a loop over files, a bare file name in a `cd` dir."""

    def test_helper_function_parameter(self):
        body = "def rep(p, old, new):\n    s = open(p).read(); assert old in s\n    open(p, 'w').write(s.replace(old, new))\n" \
               "rep('apps/x.ts', '/old/import', '/new/import')\nrep(p='apps/y.ts', old='a', new='b')"
        self.assertEqual(targets(py(body)), ["/w/apps/x.ts", "/w/apps/y.ts"])

    def test_loop_over_a_list_of_files(self):
        body = "for f in ['test/a.tsx',\n          'test/b.tsx']:\n    s = open(f).read()\n    open(f, 'w').write(s)"
        self.assertEqual(targets(py(body)), ["/w/test/a.tsx", "/w/test/b.tsx"])

    def test_loop_over_dict_keys_not_its_replacements(self):
        body = "edits = {\n    'apps/x.ts': [('/srv/kit/hooks/a.sh', '/srv/kit/hooks/b.sh')],\n}\n" \
               "for p, subs in edits.items():\n    s = open(p).read()\n    for a, b in subs:\n        s = s.replace(a, b)\n" \
               "    open(p, 'w').write(s)"
        self.assertEqual(targets(py(body)), ["/w/apps/x.ts"])

    def test_bare_file_name_in_the_cd_directory(self):
        cmd = py("p='PH-71.md'; s=open(p).read()\nopen(p,'w').write(s.replace('a', 'b'))",
                 opener="cd brain/tasks && python3 - <<'EOF'")
        self.assertEqual(targets(cmd, cwd="/w"), ["/w/brain/tasks/PH-71.md"])

    def test_helper_called_with_a_name(self):
        body = "def rep(p, o, n):\n    s=open(p).read(); open(p,'w').write(s.replace(o,n))\n" \
               "sk='.claude/skills/x/SKILL.md'\nrep(sk, '/a/b', '/c/d')"
        self.assertEqual(targets(py(body)), ["/w/.claude/skills/x/SKILL.md"])

    def test_path_built_from_a_loop_variable(self):
        body = "for f, names in {'apps/a.ts': ['X'], 'apps/b.ts': ['Y']}.items():\n    p = Path(f); s = p.read_text()\n" \
               "    p.write_text(s)"
        self.assertEqual(targets(py(body)), ["/w/apps/a.ts", "/w/apps/b.ts"])

    def test_script_argument(self):
        cmd = "cd /m && F=\"notes/t.md\" && python3 - \"$F\" <<'EOF'\nimport sys\np=sys.argv[1]; s=open(p).read()\n" \
              "open(p,'w').write(s)\nEOF"
        self.assertEqual(targets(cmd), ["/m/notes/t.md"])

    def test_home_based_path(self):
        body = "p = Path.home()/'.claude'/'hooks'/'x.sh'\nt = p.read_text()\np.write_text(t.replace('a', 'b'))"
        self.assertEqual(targets(py(body)), [os.path.expanduser("~/.claude/hooks/x.sh")])

    def test_f_string_file_name(self):
        cmd = py("for n in ['39', '40']:\n    p=f'PH-{n}.md'; s=open(p).read()\n    open(p,'w').write(s)",
                 opener="cd /v/tasks && python3 - <<'EOF'")
        self.assertEqual(targets(cmd), ["/v/tasks/PH-{n}.md"])

    def test_loop_over_a_glob(self):
        body = "import glob\nfor f in glob.glob('apps/**/*.ts', recursive=True):\n    s = open(f).read()\n" \
               "    open(f, 'w').write(s)"
        self.assertEqual(targets(py(body)), ["/w/apps/**/*.ts"])

    def test_helper_building_the_path_with_a_call(self):
        body = "H=os.path.expanduser\ndef apply(fn, reps):\n    p=pathlib.Path(H(fn)); s=p.read_text()\n" \
               "    p.write_text(s)\napply('~/w/.claude/hooks/x.sh', [('/a', '/b')])"
        self.assertEqual(targets(py(body)), [os.path.expanduser("~/w/.claude/hooks/x.sh")])

    def test_ledger_rows_quoting_hook_paths(self):
        body = "with open('.claude/state/ledger.jsonl', 'a') as f:\n" \
               "    for claim, anchor in [('x', '.claude/hooks/dictation-guard.sh'), ('y', 'CLAUDE.md')]:\n" \
               "        f.write(json.dumps({'claim': claim, 'anchor': anchor}) + '\\n')"
        self.assertEqual(targets(py(body)), ["/w/.claude/state/ledger.jsonl"])

    def test_json_dump_data_is_not_a_target(self):
        body = "d = {'hook': '/srv/kit/hooks/a.sh'}\njson.dump(d, open('/tmp/o.json', 'w'), indent=2)"
        self.assertEqual(targets(py(body)), ["/tmp/o.json"])

    def test_tsv_into_a_job_directory(self):
        body = "rows = [('~/.claude/hooks/config-git-commit.sh', 'commits config')]\nwith open('audit.tsv', 'w') as f:\n" \
               "    f.write('\\n'.join('\\t'.join(r) for r in rows))"
        self.assertEqual(targets(py(body, opener="cd /j/tmp && python3 - <<'EOF'")), ["/j/tmp/audit.tsv"])

    def test_directory_name_joined_with_a_file_name(self):
        # `x.sql` alone would land in the shell's directory, a governed apps/ here
        body = "D = '/j/sql/'\nq = open(D + 'positions.sql').read()\nopen(D + 'positions_ksd.sql', 'w').write(q)"
        self.assertEqual(targets(py(body), cwd="/w/apps"), ["/j/sql/positions_ksd.sql"])

    def test_node_directory_constant(self):
        body = "const D = '/j/out';\nfs.writeFileSync(path.join(D, 'r.md'), 'x');"
        self.assertEqual(targets(node(body)), ["/j/out/r.md"])

    def test_name_bound_twice_keeps_both_values(self):
        body = "p = 'a.md'\nopen(p, 'w').write('1')\np = 'b.md'\nopen(p, 'w').write('2')"
        self.assertEqual(targets(py(body)), ["/w/a.md", "/w/b.md"])

    def test_loop_over_a_comprehension(self):
        body = "for p in [os.path.expanduser(x) for x in ['~/a/.claude/hooks/s.sh']]:\n    open(p, 'w').write(s)"
        self.assertEqual(targets(py(body)), [os.path.expanduser("~/a/.claude/hooks/s.sh")])

    def test_loop_over_tuples_holding_a_nested_comprehension(self):
        body = "groups = [('a.spec.ts', ['a.util.spec.ts'], {n: 'x.' + n for n in ['f']})]\n" \
               "for out, srcs, mapping in groups:\n    open(out, 'w').write(t)\n    for f in srcs: os.remove(f)"
        self.assertEqual(targets(py(body, opener="cd /r/test && python3 - <<'EOF'")),
                         ["/r/test/a.spec.ts", "/r/test/a.util.spec.ts"])

    def test_loop_over_a_split_literal(self):
        self.assertEqual(targets(py("for f in 'a/x.md b/y.md'.split():\n    open(f, 'w').write('')")),
                         ["/w/a/x.md", "/w/b/y.md"])


class HeredocPathAsData(unittest.TestCase):
    """A path quoted as data is not a write target."""

    def test_tsv_rows_quoting_hook_paths(self):
        body = (
            "rows = [\n"
            "    ('/srv/kit/hooks/a.sh', 'evidence'),\n"
            "    ('/srv/kit/hooks/b.sh', 'evidence'),\n"
            "]\n"
            "with open('/tmp/out.tsv', 'w') as f:\n"
            "    for path, note in rows:\n"
            "        f.write(f'{path}\\t{note}\\n')"
        )
        self.assertEqual(targets(py(body)), ["/tmp/out.tsv"])

    def test_rows_joined_inside_the_write_call(self):
        body = "rows = ['/srv/kit/hooks/a.sh']\nout = '/tmp/out.tsv'\n" \
               "open(out, 'w').write('\\n'.join(rows + ['/srv/kit/hooks/b.sh']))"
        self.assertEqual(targets(py(body)), ["/tmp/out.tsv"])

    def test_dict_value_and_comment(self):
        body = "# was '/v/old.md'\nseen = {'hook': '/srv/kit/hooks/a.sh'}\nopen('/tmp/o', 'w').write(str(seen))"
        self.assertEqual(targets(py(body)), ["/tmp/o"])

    def test_print_next_to_an_unrelated_write(self):
        self.assertEqual(targets(py("print('/v/x.md')\nopen('/tmp/o', 'w').write('x')")), ["/tmp/o"])

    def test_name_used_only_outside_writes(self):
        body = "p = '/v/x.md'\nprint(p, open(p).read())\nopen('/tmp/o', 'w').write('x')"
        self.assertEqual(targets(py(body)), ["/tmp/o"])

    def test_node_console_log_next_to_a_write(self):
        body = "const fs = require('fs');\nconsole.log('/v/x.md');\nfs.writeFileSync('/tmp/o.txt', 'x');"
        self.assertEqual(targets(node(body)), ["/tmp/o.txt"])

    def test_node_function_body_is_not_one_statement(self):
        body = "const fs = require('fs');\nfunction main() {\n  console.log('/v/x.md');\n" \
               "  fs.writeFileSync('/tmp/o.txt', 'x');\n}\nmain();"
        self.assertEqual(targets(node(body)), ["/tmp/o.txt"])

    def test_node_written_text_is_data(self):
        self.assertEqual(targets(node("fs.writeFileSync('/tmp/o.txt', '/v/x.md');")), ["/tmp/o.txt"])

    def test_one_line_loop_writing_rows_of_dicts(self):
        # The ledger append the gate denied: `for c in C: f.write(json.dumps(c))` read C's dict values as targets.
        body = "C = [{'paths': ['.claude/hooks/a.mjs'], 'src': 'tool:Skill.skill'}]\n" \
               "with open('.claude/state/ledger.jsonl', 'a') as f:\n" \
               "  for c in C: f.write(json.dumps(c) + '\\n')"
        self.assertEqual(targets(py(body)), ["/w/.claude/state/ledger.jsonl"])

    def test_one_line_loop_whose_body_writes_its_variable(self):
        self.assertEqual(targets(py("for p in ['/v/a.md', '/v/b.md']: open(p, 'w').write('x')")), ["/v/a.md", "/v/b.md"])

    def test_header_that_writes_itself_keeps_its_target(self):
        self.assertEqual(targets(py("if (f := open('/v/x.sh', 'w')): f.write(s)")), ["/v/x.sh"])
        self.assertEqual(targets(py("while open('/v/x.sh', 'a').write(s): break")), ["/v/x.sh"])
        self.assertEqual(targets(py("for _ in [open('/v/x.sh', 'w')]: pass")), ["/v/x.sh"])

    def test_loop_over_lines_of_a_read_file(self):
        body = "for line in open('brain/list.txt'):\n    p = line.split('\\t')\n    open('/tmp/o/' + p[0], 'w').write(p[1])"
        self.assertEqual(targets(py(body)), ["/tmp/o"])

    def test_reading_heredoc_prints_nothing(self):
        self.assertEqual(targets(py("print(open('/v/x.md').read())")), [])

    def test_unclosed_comment_and_quote_end_the_scan(self):
        self.assertEqual(targets(node("fs.writeFileSync('/tmp/o.txt', s);\n/* never closed\nfs.unlinkSync('/v/x');")),
                         ["/tmp/o.txt"])
        self.assertEqual(targets(py("print('unclosed\nopen('/tmp/o', 'w').write(s)")), ["/tmp/o"])


class OtherBranchesUnchanged(unittest.TestCase):
    def test_sed_in_place(self):
        self.assertEqual(targets("sed -i '' 's/a/b/' /v/x.md"), ["/v/x.md"])

    def test_grep_redirect_counts_only_the_output(self):
        self.assertEqual(targets("grep foo /v/x.md > /tmp/o"), ["/tmp/o"])

    def test_data_heredoc_body_is_text(self):
        cmd = "cat > /v/x.md <<'EOF'\nsee '/other/p'\nopen('/other/q', 'w')\nEOF"
        self.assertEqual(targets(cmd), ["/v/x.md"])


if __name__ == "__main__":
    unittest.main()
