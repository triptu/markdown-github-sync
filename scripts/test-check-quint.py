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

    def test_temporal_verdict_requires_temporal_evidence(self):
        success = "Checking temporal properties for the complete state space\nModel checking completed. No error has been found.\n[ok]"
        violation = "Error: Temporal property q_temporalProps was violated.\nerror: found a counterexample"
        self.assertEqual(runner.classify(0, success, True, True, "tlc"), "PASS")
        self.assertEqual(runner.classify(1, violation, True, True, "tlc"), "VIOLATION")
        for code, output in [(0, "[ok]"), (1, "Error: Invariant q_inv is violated. found a counterexample"),
                             (0, "Model checking completed. No error has been found. [ok]"),
                             (124, violation), (-15, success)]:
            self.assertEqual(runner.classify(code, output, True, True, "tlc"), "ERROR")
        self.assertEqual(runner.classify(0, success, True, True, "apalache"), "ERROR")

    def test_safety_cannot_accept_a_different_failure(self):
        for error in ["Deadlock reached", "Temporal property q_temporalProps was violated", "Assertion failed"]:
            self.assertEqual(runner.classify(1, f"Error: {error}. found a counterexample", True, False, "tlc"), "ERROR")
        self.assertEqual(runner.classify(1, "Error: Invariant q_inv is violated. found a counterexample", True, False, "tlc"), "VIOLATION")

    def test_invalid_requests_fail_before_running_tools(self):
        for args in [["--only", "typo"], ["--only", "LiveConflict", "--backend=apalache"],
                     ["--only", "NegUnfair", "--simulate-only"], ["--timeout=0"]]:
            process = runner.subprocess.run([sys.executable, str(Path(runner.__file__)), *args],
                                            capture_output=True, text=True)
            self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
            self.assertIn("error:", process.stderr)

    def test_real_diagnostic_then_timeout_is_failure(self):
        code, output = runner.run([sys.executable, "-u", "-c", 'import time; print("Invariant violated"); time.sleep(5)'], dict(os.environ), timeout=0.1)
        self.assertEqual(code, 124)
        self.assertIn("Invariant violated", output)
        self.assertIn("RUNNER TIMEOUT", output)
        self.assertEqual(runner.classify(code, output), "ERROR")
        self.assertEqual(runner.classify(code, output, True), "ERROR")

    def test_final_comma_grouped_state_count(self):
        output = ("1,000 states generated, 100 distinct states found, 4 states left on queue.\n"
                  "1,359 states generated, 444 distinct states found, 0 states left on queue.\n"
                  "2,000 states generated, 500 distinct states found, 1 states left on queue")
        self.assertEqual(runner.final_state_count(output),
                         "1,359 states generated, 444 distinct states found")
        self.assertIsNone(runner.final_state_count("no complete TLC state line"))

if __name__ == "__main__":
    unittest.main()
