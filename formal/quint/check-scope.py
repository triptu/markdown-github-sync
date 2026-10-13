#!/usr/bin/env python3
"""Check the finite scope contracts using installed, checksum-pinned tools only."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
OUT = HERE / "evidence" / "scope-tlc"
CASES = [
    ("ScopeState", "PASS", True),
    ("ScopeHandoff", "PASS", True),
    ("NegScopeReview", "VIOLATION", False),
    ("NegScopeVersion", "VIOLATION", False),
    ("NegScopeFence", "VIOLATION", False),
    ("NegScopeRepo", "VIOLATION", False),
    ("NegScopeInstallation", "VIOLATION", False),
    ("NegScopeRemote", "VIOLATION", False),
    ("NegScopeCheckpoint", "VIOLATION", False),
    ("NegScopePublication", "VIOLATION", False),
    ("NegScopeIntersection", "VIOLATION", False),
    ("NegScopeUnknown", "VIOLATION", False),
    ("NegScopeOrigin", "VIOLATION", False),
    ("NegScopeAck", "VIOLATION", False),
    ("NegScopeNeighbor", "VIOLATION", False),
]
JAR_HASH = "880c0b2b72354816f12e9a9755829f2907071e9a181ffea1937954c23d54739d"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_text(path, body):
    fd, temporary = tempfile.mkstemp(prefix=".runner-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def save_evidence(manifest):
    atomic_text(OUT / "results.json", json.dumps(manifest, indent=2) + "\n")
    lines = ["# Scope Quint evidence", "", f"Status: {manifest['status']}."]
    if manifest.get("error"):
        lines += ["", f"Error: {manifest['error']}."]
    if manifest["status"] == "PASS":
        lines += ["", "TLC explored finite reachable graphs; `--max-steps=0` is not a transition cutoff.",
                  "Temporal checks use weak fairness, not a bounded deadline.",
                  "Commands, source hashes, seeds, bounds and raw logs are recorded in results.json.",
                  "", "| Case | Expected | Observed | States | Depth |", "|---|---|---|---:|---:|"]
        lines += [f"| {r['case']} | {r['expected']} | {r['observed']} | {r['states']} | {r['depth']} |"
                  for r in manifest["results"]]
    else:
        lines += ["", "Incomplete or failed invocation. No PASS verdict is claimed for these artifacts."]
    atomic_text(OUT / "summary.md", "\n".join(lines) + "\n")


def run(command, env, timeout=180):
    process = subprocess.Popen(command, cwd=HERE, env=env, text=True,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
        return process.returncode, output
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
        return 124, output + "\nTIMEOUT\n"
    except BaseException:
        os.killpg(process.pid, signal.SIGTERM)
        process.communicate()
        raise


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def verdict(code, output, temporal):
    if code == 0 and "[ok]" in output and "Model checking completed. No error has been found." in output:
        return "PASS" if not temporal or "Checking temporal properties" in output else "ERROR"
    if code == 1 and "found a counterexample" in output and "Error: Invariant q_inv is violated." in output:
        return "VIOLATION"
    return "ERROR"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    lock = (OUT / ".runner.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        print("Scope evidence directory is locked by another invocation", file=sys.stderr)
        return 1
    old_handler = signal.getsignal(signal.SIGTERM)
    def interrupt(_signum, _frame):
        raise InterruptedError("interrupted by SIGTERM")
    signal.signal(signal.SIGTERM, interrupt)
    result = {"status": "RUNNING", "selected": [name for name, _, _ in CASES],
              "backend": "TLC via generated TLA", "quint": "0.33.0", "apalache": "0.62.1",
              "jarSha256": JAR_HASH, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "inputsUnchanged": False, "sources": {}, "results": [], "errors": []}
    try:
        # The manifest becomes incomplete before any fallible tool preflight.
        save_evidence(result)
        for name, _, _ in CASES:
            for suffix in ("typecheck.log", "verify.log"):
                (OUT / f"{name}.{suffix}").unlink(missing_ok=True)
        check_cases(result)
    except BaseException as error:
        result["errors"].append(f"{type(error).__name__}: {error}")
    finally:
        result["status"] = "PASS" if not result["errors"] and result["inputsUnchanged"] and len(result["results"]) == len(CASES) else "FAIL"
        if result["errors"]:
            result["error"] = "; ".join(result["errors"])
        save_evidence(result)
        signal.signal(signal.SIGTERM, old_handler)
        lock.close()
    return 0 if result["status"] == "PASS" else 1


def check_cases(result):
    quint = Path(os.environ.get("QUINT_BIN", HERE / "node_modules" / ".bin" / "quint"))
    tool_home = Path(os.environ.get("QUINT_HOME", HERE / ".tools"))
    jar = tool_home / "apalache-dist-0.62.1" / "apalache" / "lib" / "apalache.jar"
    if not quint.exists() or not jar.exists() or sha(jar) != JAR_HASH:
        raise RuntimeError("Pinned Quint/Apalache cache missing or invalid; no download attempted")
    if subprocess.check_output([str(quint), "--version"], text=True).strip() != "0.33.0":
        raise RuntimeError("Quint version mismatch")
    env = dict(os.environ)
    java_name = env.get("JAVA_HOME")
    java = Path(java_name) / "bin" / "java" if java_name else shutil.which("java")
    if not java or not Path(java).exists():
        raise RuntimeError("Java 21+ required; set JAVA_HOME")
    java = Path(java)
    java_version = subprocess.check_output([str(java), "-version"], stderr=subprocess.STDOUT, text=True).splitlines()[0]
    match = re.search(r'version "(\d+)', java_version)
    if not match or int(match.group(1)) < 21:
        raise RuntimeError("Java 21+ required; set JAVA_HOME")
    result["java"] = java_version
    env["PATH"] = str(java.parent) + os.pathsep + env.get("PATH", "")
    env["QUINT_HOME"] = str(tool_home)
    inputs = [HERE / "scopeState.qnt", HERE / "scopeHandoff.qnt", HERE / "check-scope.py",
              HERE / "test-check-scope.py",
              HERE / "tlc-config.json", HERE / "package-lock.json"] + [HERE / "models" / f"{name}.qnt" for name, _, _ in CASES]
    sources = {str(path.relative_to(HERE)): sha(path) for path in inputs}
    result["sources"] = sources
    save_evidence(result)
    for name, expected, temporal in CASES:
        source = f"models/{name}.qnt"
        code, output = run([str(quint), "typecheck", source], env)
        (OUT / f"{name}.typecheck.log").write_text(f"exit={code}\n{output}")
        if code:
            result["results"].append({"case": name, "expected": expected, "observed": "ERROR", "typecheckExit": code})
            result["errors"].append(f"{name}: typecheck exit {code}")
            save_evidence(result)
            continue
        start = time.monotonic()
        attempts = []
        for _ in range(3):
            command = [str(quint), "verify", source, "--backend=tlc", "--max-steps=0",
                       "--invariant=safe", "--apalache-version=0.62.1",
                       f"--server-endpoint=localhost:{port()}", "--tlc-config=tlc-config.json", "--verbosity=3"]
            if temporal:
                command.append("--temporal=progress")
            code, output = run(command, env)
            attempts.append({"command": command, "exit": code, "output": output})
            if "Failed to bind to address" not in output:
                break
        (OUT / f"{name}.verify.log").write_text("".join(
            f"attempt={index + 1} exit={item['exit']}\n{item['output']}" +
            ("" if item["output"].endswith("\n") else "\n")
            for index, item in enumerate(attempts)))
        observed = verdict(code, output, temporal)
        counts = re.findall(r"(?m)^([\d,]+ states generated, [\d,]+ distinct states found), [\d,]+ states left on queue\.$", output)
        depth = re.search(r"The depth of the complete state graph search is (\d+)\.", output)
        seed = re.search(r"Running breadth-first search Model-Checking with fp \d+ and seed (-?\d+)", output)
        record = {"case": name, "property": "safe", "temporal": "progress" if temporal else None,
                  "expected": expected, "observed": observed,
                  "valid": observed == expected and bool(counts) and bool(seed),
                  "typecheckExit": 0, "verifyExit": code, "transitionBound": None,
                  "dataBounds": "one configuration path, one hidden path" if name not in ("ScopeHandoff", "NegScopeAck", "NegScopeNeighbor") else "one held path, one malformed neighbor",
                  "states": counts[-1] if counts else None, "depth": int(depth.group(1)) if depth else None,
                  "tlcSeed": seed.group(1) if seed else None, "seconds": round(time.monotonic() - start, 2),
                  "command": command,
                  "attempts": [{"command": item["command"], "exit": item["exit"]} for item in attempts]}
        result["results"].append(record)
        if not record["valid"]:
            result["errors"].append(f"{name}: expected {expected}, observed {observed}")
        save_evidence(result)
        print(f"{name}: {observed} ({record['states']})", flush=True)
    result["inputsUnchanged"] = all(path.exists() and sha(path) == sources[str(path.relative_to(HERE))] for path in inputs)
    if not result["inputsUnchanged"]:
        result["errors"].append("input changed during invocation")


if __name__ == "__main__":
    sys.exit(main())
