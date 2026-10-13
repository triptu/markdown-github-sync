#!/usr/bin/env python3
"""Regression tests for the scope runner's evidence lifecycle."""
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

RUNNER = Path(__file__).with_name("check-scope.py")
spec = importlib.util.spec_from_file_location("scope_runner", RUNNER)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

PASS_LOG = ("Running breadth-first search Model-Checking with fp 59 and seed 123 with 2 workers\n"
            "Checking temporal properties for the complete state space\n"
            "Model checking completed. No error has been found.\n"
            "5 states generated, 3 distinct states found, 0 states left on queue.\n"
            "The depth of the complete state graph search is 2.\n"
            "[ok] No violation found\n")


class ScopeRunnerEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="scope-runner-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.out = self.root / "evidence" / "scope-tlc"
        self.out.mkdir(parents=True)
        (self.root / "models").mkdir()
        for name in ("scopeState.qnt", "scopeHandoff.qnt", "tlc-config.json", "package-lock.json"):
            (self.root / name).write_text("fixture\n")
        (self.root / "models" / "ScopeState.qnt").write_text("fixture\n")
        shutil.copyfile(RUNNER, self.root / "check-scope.py")
        shutil.copyfile(Path(__file__), self.root / "test-check-scope.py")
        self.quint = self.root / "quint"
        self.quint.write_text("fixture\n")
        self.tool_home = self.root / "tools"
        jar = self.tool_home / "apalache-dist-0.62.1" / "apalache" / "lib" / "apalache.jar"
        jar.parent.mkdir(parents=True)
        jar.write_bytes(b"fixture jar")
        self.java_home = self.root / "jdk"
        (self.java_home / "bin").mkdir(parents=True)
        (self.java_home / "bin" / "java").write_text("fixture\n")
        self.patches = [
            mock.patch.object(checker, "HERE", self.root),
            mock.patch.object(checker, "OUT", self.out),
            mock.patch.object(checker, "CASES", [("ScopeState", "PASS", True)]),
            mock.patch.object(checker, "JAR_HASH", hashlib.sha256(jar.read_bytes()).hexdigest()),
            mock.patch.dict(os.environ, {"QUINT_BIN": str(self.quint), "QUINT_HOME": str(self.tool_home),
                                      "JAVA_HOME": str(self.java_home)}),
            mock.patch.object(checker.subprocess, "check_output", side_effect=self.check_output),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.seed_old_success()

    def check_output(self, args, **_kwargs):
        return "0.33.0\n" if "--version" in args else 'openjdk version "23.0.2"\n'

    def seed_old_success(self):
        old = self.out / "runs" / "prior"
        old.mkdir(parents=True)
        (self.out / "results.json").write_text('{"status":"PASS","artifactDir":"runs/prior"}\n')
        (self.out / "summary.md").write_text("Read results.json for the current verdict.\n")
        (old / "ScopeState.verify.log").write_text("[ok] historical success\n")

    def result(self):
        return json.loads((self.out / "results.json").read_text())

    def run_good(self, command, _env, _timeout=180):
        return (0, "") if command[1] == "typecheck" else (0, PASS_LOG)

    def test_missing_tool_invalidates_manifest_summary_and_log(self):
        with (mock.patch.dict(os.environ, {"QUINT_BIN": str(self.root / "missing")}),
              mock.patch.object(checker, "run", side_effect=self.run_good)):
            self.assertEqual(checker.main(), 1)
        self.assertEqual(self.result()["status"], "FAIL")
        self.assertNotIn("Status: PASS", (self.out / "summary.md").read_text())
        self.assertFalse((self.out / "ScopeState.verify.log").exists())
        self.assertNotIn("artifactDir", self.result())

    def test_typecheck_failure_removes_stale_verify_log(self):
        with mock.patch.object(checker, "run", return_value=(1, "typecheck failed")):
            self.assertEqual(checker.main(), 1)
        self.assertEqual(self.result()["status"], "FAIL")
        self.assertFalse((self.out / self.result()["activeArtifactDir"] / "ScopeState.verify.log").exists())
        self.assertEqual(self.result()["results"][0]["observed"], "ERROR")

    def test_sigterm_during_check_fails_closed(self):
        def interrupted(_command, _env, _timeout=180):
            os.kill(os.getpid(), signal.SIGTERM)
        with mock.patch.object(checker, "run", side_effect=interrupted):
            self.assertEqual(checker.main(), 1)
        self.assertEqual(self.result()["status"], "FAIL")
        self.assertIn("Cancelled", self.result()["error"])
        self.assertFalse((self.out / self.result()["activeArtifactDir"] / "ScopeState.verify.log").exists())

    def test_concurrent_invocation_does_not_touch_active_evidence(self):
        lock = (self.out / ".runner.lock").open("w")
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with open(os.devnull, "w") as sink, contextlib.redirect_stderr(sink):
            self.assertEqual(checker.main(), 1)
        self.assertEqual(self.result()["status"], "PASS")
        self.assertTrue((self.out / "runs" / "prior" / "ScopeState.verify.log").exists())

    def test_changed_input_cannot_finish_pass(self):
        def drift(command, env, timeout=180):
            if command[1] == "verify":
                with (self.root / "scopeState.qnt").open("a") as stream:
                    stream.write("changed\n")
            return self.run_good(command, env, timeout)
        with mock.patch.object(checker, "run", side_effect=drift):
            self.assertEqual(checker.main(), 1)
        self.assertEqual(self.result()["status"], "FAIL")
        self.assertFalse(self.result()["inputsUnchanged"])

    def test_wrong_verdict_cannot_finish_pass(self):
        def wrong(command, env, timeout=180):
            if command[1] == "verify":
                return 1, "Error: Invariant q_inv is violated. found a counterexample\n" + PASS_LOG
            return self.run_good(command, env, timeout)
        with mock.patch.object(checker, "run", side_effect=wrong):
            self.assertEqual(checker.main(), 1)
        self.assertEqual(self.result()["status"], "FAIL")
        self.assertEqual(self.result()["results"][0]["observed"], "VIOLATION")

    def test_success_replaces_old_evidence(self):
        with mock.patch.object(checker, "run", side_effect=self.run_good):
            self.assertEqual(checker.main(), 0)
        self.assertEqual(self.result()["status"], "PASS")
        self.assertNotEqual(self.result()["artifactDir"], "runs/prior")
        self.assertIn("[ok]", (self.out / self.result()["artifactDir"] / "ScopeState.verify.log").read_text())

    def test_bind_collision_retries_and_records_both_attempts(self):
        calls = 0
        def collision(command, env, timeout=180):
            nonlocal calls
            if command[1] == "verify":
                calls += 1
                if calls == 1:
                    return 1, "Failed to bind to address 0.0.0.0:12345: Address already in use\n"
            return self.run_good(command, env, timeout)
        with mock.patch.object(checker, "run", side_effect=collision):
            self.assertEqual(checker.main(), 0)
        self.assertEqual(len(self.result()["results"][0]["attempts"]), 2)
        self.assertIn("Failed to bind", (self.out / self.result()["artifactDir"] / "ScopeState.verify.log").read_text())


@unittest.skipUnless(os.environ.get("SCOPE_REAL_TOOL_TESTS") == "1", "set SCOPE_REAL_TOOL_TESTS=1 with pinned tools")
class RealRunnerInterruptionTests(unittest.TestCase):
    def setUp(self):
        for key in ("QUINT_BIN", "QUINT_HOME", "JAVA_HOME"):
            if not os.environ.get(key):
                self.skipTest(f"{key} is required for real TLC probes")
        self.temporary = tempfile.TemporaryDirectory(prefix="scope-real-runner-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "models").mkdir()
        for name in ("scopeState.qnt", "scopeHandoff.qnt", "check-scope.py", "test-check-scope.py",
                     "tlc-config.json", "package-lock.json"):
            shutil.copyfile(RUNNER.with_name(name), self.root / name)
        shutil.copyfile(RUNNER.with_name("models") / "ScopeState.qnt", self.root / "models" / "ScopeState.qnt")
        self.out = self.root / "evidence" / "scope-tlc"
        self.out.mkdir(parents=True)
        shutil.copyfile(RUNNER.parent / "evidence" / "scope-tlc" / "summary.md", self.out / "summary.md")
        self.wrapper = self.root / "wrapper.py"
        self.wrapper.write_text('''from pathlib import Path
import importlib.util,os,sys,time
q=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("scope",q/"check-scope.py")
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.CASES=[("ScopeState","PASS",True)]
mode=sys.argv[1]
if mode=="term":
    original=c.subprocess.Popen
    def observe(command,*args,**kwargs):
        process=original(command,*args,**kwargs)
        if "verify" in command:(q/"child.pid").write_text(str(process.pid))
        return process
    c.subprocess.Popen=observe
elif mode=="kill":
    original=c.save_evidence
    def pause(manifest):
        original(manifest)
        if manifest["status"]=="RUNNING" and not (q/"paused").exists():
            (q/"paused").write_text("after atomic RUNNING manifest")
            while True:time.sleep(.1)
    c.save_evidence=pause
elif mode=="summary-error":
    def fail(_run_dir,_records):raise OSError("injected generation-summary write failure")
    c.write_run_summary=fail
sys.exit(c.main())
''')

    def launch(self, mode):
        log = (self.root / f"{mode}.log").open("w")
        self.addCleanup(log.close)
        return subprocess.Popen([sys.executable, str(self.wrapper), mode], env=os.environ.copy(),
                                stdout=log, stderr=subprocess.STDOUT)

    def wait_for(self, path, process):
        deadline = time.monotonic() + 20
        while not path.exists():
            self.assertIsNone(process.poll(), f"process exited before {path.name}")
            self.assertLess(time.monotonic(), deadline, f"timed out waiting for {path.name}")
            time.sleep(.01)

    def manifest(self):
        return json.loads((self.out / "results.json").read_text())

    def test_real_tlc_sigterm_stops_verifier_group(self):
        process = self.launch("term")
        self.wait_for(self.root / "child.pid", process)
        child = int((self.root / "child.pid").read_text())
        self.assertIsNone(process.poll())
        time.sleep(.2)
        process.send_signal(signal.SIGTERM)
        self.assertNotEqual(process.wait(timeout=15), 0)
        manifest = self.manifest()
        self.assertEqual(manifest["status"], "FAIL")
        self.assertNotIn("artifactDir", manifest)
        self.assertIn("Cancelled", manifest["error"])
        self.assertFalse((self.out / manifest["activeArtifactDir"] / "ScopeState.verify.log").exists())
        time.sleep(.2)
        try:
            os.killpg(child, 0)
        except ProcessLookupError:
            pass
        else:
            os.killpg(child, signal.SIGKILL)
            self.fail("verifier process group remained after SIGTERM")

    def test_real_sigkill_after_invalidation_has_no_current_pass(self):
        first = self.launch("normal")
        self.assertEqual(first.wait(timeout=25), 0)
        prior = self.manifest()
        self.assertEqual(prior["status"], "PASS")
        self.assertTrue((self.out / prior["artifactDir"] / "ScopeState.verify.log").exists())
        process = self.launch("kill")
        self.wait_for(self.root / "paused", process)
        process.send_signal(signal.SIGKILL)
        self.assertNotEqual(process.wait(timeout=10), 0)
        current = self.manifest()
        self.assertEqual(current["status"], "RUNNING")
        self.assertNotIn("artifactDir", current)
        self.assertNotIn("Status: PASS.", (self.out / "summary.md").read_text())
        self.assertFalse((self.out / "ScopeState.verify.log").exists())

    def test_real_summary_failure_cannot_expose_old_pass(self):
        first = self.launch("normal")
        self.assertEqual(first.wait(timeout=25), 0)
        process = self.launch("summary-error")
        self.assertNotEqual(process.wait(timeout=25), 0)
        current = self.manifest()
        self.assertEqual(current["status"], "FAIL")
        self.assertNotIn("artifactDir", current)
        self.assertIn("generation-summary write failure", current["error"])
        self.assertNotIn("Status: PASS.", (self.out / "summary.md").read_text())
        self.assertFalse((self.out / "ScopeState.verify.log").exists())


if __name__ == "__main__":
    unittest.main()
