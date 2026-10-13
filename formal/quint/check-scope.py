#!/usr/bin/env python3
"""Check the finite scope contracts using installed, checksum-pinned tools only."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
OUT = HERE / "evidence" / "scope-tlc"
CASES = [
    ("ScopeState", "PASS", True),
    ("ScopeHandoff", "PASS", True),
    ("NegScopeReview", "VIOLATION", False),
    ("NegScopeVersion", "VIOLATION", False),
    ("NegScopeFence", "VIOLATION", False),
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
    quint = Path(os.environ.get("QUINT_BIN", HERE / "node_modules" / ".bin" / "quint"))
    tool_home = Path(os.environ.get("QUINT_HOME", HERE / ".tools"))
    jar = tool_home / "apalache-dist-0.62.1" / "apalache" / "lib" / "apalache.jar"
    if not quint.exists() or not jar.exists() or sha(jar) != JAR_HASH:
        sys.exit("Use existing Quint 0.33.0 and checksum-pinned Apalache 0.62.1 caches; no download attempted")
    if subprocess.check_output([str(quint), "--version"], text=True).strip() != "0.33.0":
        sys.exit("Quint version mismatch")
    env = dict(os.environ)
    java = Path(env.get("JAVA_HOME", "")) / "bin" / "java" if env.get("JAVA_HOME") else Path(shutil.which("java") or "")
    if not java.exists():
        sys.exit("Java 21+ required; set JAVA_HOME")
    java_version = subprocess.check_output([str(java), "-version"], stderr=subprocess.STDOUT, text=True).splitlines()[0]
    match = re.search(r'version "(\d+)', java_version)
    if not match or int(match.group(1)) < 21:
        sys.exit("Java 21+ required; set JAVA_HOME")
    env["PATH"] = str(java.parent) + os.pathsep + env.get("PATH", "")
    env["QUINT_HOME"] = str(tool_home)
    OUT.mkdir(parents=True, exist_ok=True)
    inputs = [HERE / "scopeState.qnt", HERE / "scopeHandoff.qnt", HERE / "check-scope.py",
              HERE / "tlc-config.json", HERE / "package-lock.json"] + [HERE / "models" / f"{name}.qnt" for name, _, _ in CASES]
    sources = {str(path.relative_to(HERE)): sha(path) for path in inputs}
    (OUT / "results.json").write_text(json.dumps({"status": "RUNNING", "sources": sources}) + "\n")
    records = []
    bad = False
    for name, expected, temporal in CASES:
        source = f"models/{name}.qnt"
        tc = [str(quint), "typecheck", source]
        code, output = run(tc, env)
        (OUT / f"{name}.typecheck.log").write_text(f"exit={code}\n{output}")
        if code:
            records.append({"case": name, "observed": "ERROR", "typecheckExit": code})
            bad = True
            continue
        command = [str(quint), "verify", source, "--backend=tlc", "--max-steps=0",
                   "--invariant=safe", "--apalache-version=0.62.1",
                   f"--server-endpoint=localhost:{port()}", "--tlc-config=tlc-config.json", "--verbosity=3"]
        if temporal:
            command.append("--temporal=progress")
        start = time.monotonic()
        code, output = run(command, env)
        (OUT / f"{name}.verify.log").write_text(f"exit={code}\n{output}")
        observed = verdict(code, output, temporal)
        counts = re.findall(r"(?m)^([\d,]+ states generated, [\d,]+ distinct states found), [\d,]+ states left on queue\.$", output)
        depth = re.search(r"The depth of the complete state graph search is (\d+)\.", output)
        seed = re.search(r"Running breadth-first search Model-Checking with fp \d+ and seed (-?\d+)", output)
        record = {"case": name, "property": "safe", "temporal": "progress" if temporal else None,
                  "expected": expected, "observed": observed, "valid": observed == expected,
                  "typecheckExit": 0, "verifyExit": code, "transitionBound": None,
                  "dataBounds": "one configuration path, one hidden path" if name.endswith("State") or name.startswith("NegScope") and name not in ("NegScopeAck", "NegScopeNeighbor") else "one held path, one malformed neighbor",
                  "states": counts[-1] if counts else None, "depth": int(depth.group(1)) if depth else None,
                  "tlcSeed": seed.group(1) if seed else None, "seconds": round(time.monotonic() - start, 2),
                  "command": command}
        records.append(record)
        bad |= not record["valid"] or record["states"] is None
        print(f"{name}: {observed} ({record['states']})", flush=True)
    unchanged = all(path.exists() and sha(path) == sources[str(path.relative_to(HERE))] for path in inputs)
    bad |= not unchanged
    result = {"status": "FAIL" if bad else "PASS", "backend": "TLC via generated TLA",
              "quint": "0.33.0", "apalache": "0.62.1", "jarSha256": JAR_HASH,
              "java": java_version, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "inputsUnchanged": unchanged, "sources": sources, "results": records}
    (OUT / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    lines = ["# Scope Quint evidence", "", f"Status: {result['status']}; Quint 0.33.0, Apalache 0.62.1, {java_version}.",
             "", "TLC explored the finite reachable graph; `--max-steps=0` is not a transition cutoff.",
             "Temporal checks use weak fairness, not a bounded deadline. Source hashes, exact commands, seeds, bounds and logs are in results.json.",
             "", "| Case | Expected | Observed | States | Depth |", "|---|---|---|---:|---:|"]
    lines += [f"| {r['case']} | {r.get('expected', '?')} | {r['observed']} | {r.get('states', '?')} | {r.get('depth', '?')} |" for r in records]
    (OUT / "summary.md").write_text("\n".join(lines) + "\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
