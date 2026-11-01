"""The python helpers read a command as UTF-8 whatever the locale says.

Windows' default stdin encoding is cp1252: the A0 byte of «Р» came in as a no-break space, `\\s` cut
`echo x > /tmp/Рецепт.md` to `/tmp/\\xd0`, and the skill gate checked a path nobody wrote; one «—» became three
characters and shifted every offset after it. The cases run with PYTHONUTF8 / PYTHONIOENCODING removed, so they fail on a
cp1252 machine without the fix (and pass anywhere with it).
Run from the kit root: python3 -B -m unittest discover -s instructions-tuning/test
"""
import os
import subprocess
import sys
import unittest

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "payload", "hooks", "_lib")


def run(script, args, command):
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONUTF8", "PYTHONIOENCODING")}
    out = subprocess.run([sys.executable, "-B", os.path.join(LIB, script), *args], input=command.encode("utf-8"),
                         capture_output=True, env=env, check=True)
    return out.stdout.decode("utf-8")


class Utf8Stdin(unittest.TestCase):
    def test_cyrillic_redirect_target_is_whole(self):
        self.assertEqual(run("bash-write-targets.py", ["/tmp"], "echo x > /tmp/Рецепт.md").split(), ["/tmp/Рецепт.md"])

    def test_cyrillic_heredoc_target_is_whole(self):
        self.assertEqual(run("bash-write-targets.py", ["/tmp"], "cat > /tmp/Р.md <<EOF\nhi\nEOF").split(), ["/tmp/Р.md"])

    def test_strip_keeps_text_and_length(self):
        command = 'echo "Ёлка — тест" > /tmp/a # Ёж'
        out = run("shell_text.py", ["strip"], command)
        self.assertEqual(out, 'echo "Ёлка — тест" > /tmp/a     ')
        self.assertEqual(len(out), len(command))


if __name__ == "__main__":
    unittest.main()
