import pathlib
import subprocess
import sys
import tempfile
import unittest


class CILogTest(unittest.TestCase):
    def test_full_logs_bounded_console_and_exit_status(self):
        wrapper = pathlib.Path(__file__).with_name("ci-log.py")
        for status in (0, 7):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                log = pathlib.Path(directory) / "full.log"
                result = subprocess.run(
                    [sys.executable, str(wrapper), str(log), sys.executable, "-c",
                     "import sys; print('@KW@ 123 stage compile'); "
                     "[print('noise ' + str(i)) for i in range(10000)]; "
                     "print('final diagnostic', file=sys.stderr); "
                     f"sys.exit({status})"],
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, status)
                self.assertIn("@KW@ 123 stage compile", result.stdout)
                self.assertLess(len(result.stdout.splitlines()), 50)
                self.assertEqual(len(log.read_text().splitlines()), 10002)
                self.assertIn("final diagnostic", log.read_text())
                if status:
                    self.assertIn("Last 40 log lines", result.stdout)


if __name__ == "__main__":
    unittest.main()
