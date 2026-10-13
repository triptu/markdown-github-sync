import importlib.util
import os
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("check-quint.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class VerdictTests(unittest.TestCase):
    def test_normal_verdicts(self):
        self.assertEqual(runner.classify(0, "[ok]"), "PASS")
        self.assertEqual(runner.classify(1, "Invariant violated"), "VIOLATION")
        self.assertEqual(runner.classify(1, "found a counterexample", True), "VIOLATION")
        self.assertEqual(runner.classify(1, "backend crashed", True), "ERROR")

    def test_abnormal_exit_cannot_be_a_counterexample(self):
        for code in [124, -9, -15, 2, 137]:
            for verification in [False, True]:
                self.assertEqual(runner.classify(code, "[ok] Invariant violated; found a counterexample", verification), "ERROR")

    def test_real_diagnostic_then_timeout_is_failure(self):
        code, output = runner.run([sys.executable, "-u", "-c", 'import time; print("Invariant violated"); time.sleep(5)'], dict(os.environ), timeout=0.1)
        self.assertEqual(code, 124)
        self.assertIn("Invariant violated", output)
        self.assertIn("RUNNER TIMEOUT", output)
        self.assertEqual(runner.classify(code, output), "ERROR")
        self.assertEqual(runner.classify(code, output, True), "ERROR")

if __name__ == "__main__":
    unittest.main()
