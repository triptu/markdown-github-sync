#!/usr/bin/env python3
"""Check synthetic Quint specifications, never a real vault or GitHub repository."""
import argparse
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

ROOT = Path(__file__).resolve().parents[1]
FORMAL = ROOT / "formal" / "quint"
QUINT_VERSION = "0.33.0"
APALACHE_VERSION = "0.62.1"
JAR_SHA256 = "880c0b2b72354816f12e9a9755829f2907071e9a181ffea1937954c23d54739d"
# module, schedule depth, expected result, exact property for negative control
CASES = [
    ("Core", 6, "PASS", "safe"),
    ("Independent", 21, "PASS", "safe and completed"),
    ("ResponseLoss", 13, "PASS", "safe and completed"),
    ("UnknownRewind", 6, "PASS", "safe and completed"),
    ("ExactPublish", 5, "PASS", "safe and completed"),
    ("Application", 8, "PASS", "safe and completed"),
    ("StaleDecision", 7, "PASS", "safe and completed"),
    ("NegReplay", 6, "VIOLATION", "unknownHeld"),
    ("NegFastForward", 5, "VIOLATION", "exactHead"),
    ("NegJournal", 8, "VIOLATION", "journalFirst"),
    ("NegGuard", 8, "VIOLATION", "newerPreserved"),
    ("NegCapture", 8, "VIOLATION", "carriedCaptured"),
    ("NegCheckpoint", 8, "VIOLATION", "wholeCheckpoint"),
    ("NegStaleDecision", 7, "VIOLATION", "scopedDecisions"),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, env, timeout=180):
    """Own and terminate the process group, including checker JVMs, on timeout."""
    process = subprocess.Popen(command, cwd=FORMAL, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, start_new_session=True)
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
        return 124, output + "\nRUNNER TIMEOUT: no verification verdict.\n"


def java_env():
    env = dict(os.environ)
    candidates = [shutil.which("java")]
    if env.get("JAVA_HOME"):
        candidates.insert(0, str(Path(env["JAVA_HOME"]) / "bin" / "java"))
    if Path("/usr/libexec/java_home").exists():
        found = subprocess.run(["/usr/libexec/java_home", "-v", "21+"], capture_output=True, text=True)
        if found.returncode == 0:
            candidates.append(str(Path(found.stdout.strip()) / "bin" / "java"))
    for java in candidates:
        if not java or not Path(java).exists():
            continue
        version = subprocess.run([java, "-version"], capture_output=True, text=True)
        output = version.stdout + version.stderr
        match = re.search(r'version "(\d+)', output)
        if match and int(match[1]) >= 21:
            java = Path(java).resolve()
            env["JAVA_HOME"] = str(java.parent.parent)
            env["PATH"] = str(java.parent) + os.pathsep + env.get("PATH", "")
            env["QUINT_HOME"] = str(FORMAL / ".tools")
            return env, output.splitlines()[0]
    raise SystemExit("Apalache 0.62.1 requires Java >=21. Set JAVA_HOME to a compatible JDK.")


def available_port():
    # Never accidentally attach to somebody else's unpinned backend server.
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def decode(value):
    if isinstance(value, list):
        return [decode(item) for item in value]
    if not isinstance(value, dict):
        return value
    if "#bigint" in value:
        return int(value["#bigint"])
    if "#map" in value:
        return {str(decode(key)): decode(item) for key, item in value["#map"]}
    if "#set" in value:
        return decode(value["#set"])
    if "#tup" in value:
        return decode(value["#tup"])
    return {key: decode(item) for key, item in value.items()}


def readable_trace(path):
    """Keep raw ITF as the authority; provide a compact review aid alongside it."""
    if not path.exists():
        return
    trace = json.loads(path.read_text())
    lines = ["Raw trace: " + path.name, ""]
    for state in trace.get("states", []):
        values = decode(state)
        protocol = next((value for key, value in values.items() if key.endswith("::s")), None)
        if protocol is None:
            continue
        lines.append(f"State {state['#meta']['index']}: {protocol['event']}; head={protocol['head']}; failures={protocol['failures']}")
        for device, value in protocol["dev"].items():
            selected = {key: value[key] for key in ["phase", "checkpoint", "candidate", "target", "journal", "accounted", "live", "draft", "carry", "decisions", "recovery"]}
            lines.append(f"  device {device}: " + json.dumps(selected, sort_keys=True))
    path.with_suffix(".txt").write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["tlc", "apalache"], default="tlc")
    parser.add_argument("--only", nargs="+", choices=[case[0] for case in CASES])
    parser.add_argument("--simulate-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    env, java_version = java_env()
    q = FORMAL / "node_modules" / ".bin" / "quint"
    if not q.exists():
        code, output = run(["npm", "ci", "--ignore-scripts"], env)
        if code != 0:
            raise SystemExit(output)
    if subprocess.check_output([str(q), "--version"], text=True).strip() != QUINT_VERSION:
        raise SystemExit("Quint version mismatch; run npm ci --prefix formal/quint --ignore-scripts")
    evidence = FORMAL / "evidence" / ("simulation" if args.simulate_only else args.backend)
    evidence.mkdir(parents=True, exist_ok=True)
    jar = FORMAL / ".tools" / f"apalache-dist-{APALACHE_VERSION}" / "apalache" / "lib" / "apalache.jar"
    if not args.simulate_only:
        if not jar.exists():
            # Official pinned download helper fetches/extracts only; no JVM runs
            # until the downloaded JAR's checksum has been validated below.
            code, output = run(["node", "-e", "require('./node_modules/@informalsystems/quint/dist/src/apalache.js').fetchApalache('0.62.1', 1).then(r => { if (r.isLeft()) { process.stderr.write(JSON.stringify(r.value)); process.exit(1) } })"], env)
            if code != 0:
                raise SystemExit(output)
        if digest(jar) != JAR_SHA256:
            raise SystemExit("Pinned Apalache JAR checksum mismatch; refusing to execute backend")
    selected = [case for case in CASES if not args.only or case[0] in args.only]
    records = []
    commands = []
    bad = False
    for name, bound, expected, invariant in selected:
        source = f"models/{name}.qnt"
        code, output = run([str(q), "typecheck", source], env, args.timeout)
        (evidence / f"{name}.typecheck.log").write_text(f"exit={code}\n" + output)
        if code != 0:
            bad = True
            records.append({"case": name, "kind": "typecheck", "observed": "ERROR", "exit": code})
            print(f"{name}: TYPECHECK ERROR", flush=True)
            continue
        simulation_itf = evidence / f"{name}.simulation.itf.json"
        simulation = [str(q), "run", source, "--backend=typescript", "--max-samples=1000",
                      f"--max-steps={bound}", "--seed=0x123456", f"--invariant={invariant}",
                      f"--out-itf={simulation_itf}", "--verbosity=1"]
        if expected == "PASS" and name != "Core":
            simulation.append("--witnesses=witness")
        start = time.monotonic()
        code, output = run(simulation, env, args.timeout)
        (evidence / f"{name}.simulation.log").write_text(f"exit={code}\n" + output)
        readable_trace(simulation_itf)
        observed = "PASS" if code == 0 and "[ok]" in output else "VIOLATION" if code != 0 and "Invariant violated" in output else "ERROR"
        witnesses = re.search(r'witness was witnessed in (\d+) trace\(s\) out of (\d+) explored', output)
        nonvacuous = expected != "PASS" or name == "Core" or (witnesses and witnesses[1] == witnesses[2] and int(witnesses[1]) > 0)
        valid = observed == expected and bool(nonvacuous)
        bad |= not valid
        records.append({"case": name, "kind": "simulation", "bound": bound, "expected": expected,
                        "observed": observed, "valid": valid, "exit": code, "seconds": round(time.monotonic() - start, 2),
                        "witnesses": witnesses[0] if witnesses else None})
        commands.append(simulation)
        print(f"{name}: simulation {observed} ({'OK' if valid else 'MISMATCH'})", flush=True)
        if args.simulate_only:
            continue
        verify = [str(q), "verify", source, f"--backend={args.backend}", f"--max-steps={bound}",
                  f"--invariant={invariant}", f"--apalache-version={APALACHE_VERSION}",
                  f"--server-endpoint=localhost:{available_port()}", "--verbosity=3"]
        if args.backend == "tlc":
            verify.append("--tlc-config=tlc-config.json")
        else:
            # TLC currently reports its counterexample in the raw log. Apalache
            # supports machine-readable ITF; preserve it without suppressing logs.
            pass
        start = time.monotonic()
        code, output = run(verify, env, args.timeout)
        (evidence / f"{name}.verify.log").write_text(f"exit={code}\n" + output)
        observed = "PASS" if code == 0 and "[ok]" in output else "VIOLATION" if code != 0 and ("Invariant violated" in output or "found a counterexample" in output) else "ERROR"
        valid = observed == expected
        bad |= not valid
        states = re.search(r'(\d+) states generated, (\d+) distinct states found', output)
        records.append({"case": name, "kind": args.backend, "bound": bound, "expected": expected,
                        "observed": observed, "valid": valid, "exit": code,
                        "seconds": round(time.monotonic() - start, 2),
                        "states": states[0] if states else None})
        commands.append(verify)
        print(f"{name}: {args.backend} {observed} ({'OK' if valid else 'MISMATCH'})", flush=True)
    sources = sorted(FORMAL.rglob("*.qnt"))
    sources = [path for path in sources if not any(part in path.parts for part in ["node_modules", ".tools", "_generated"])]
    inputs = sources + [FORMAL / "package-lock.json", FORMAL / "tlc-config.json", Path(__file__).resolve()]
    metadata = {"quint": QUINT_VERSION, "apalache": APALACHE_VERSION, "apalacheJarSha256": JAR_SHA256,
                "java": java_version, "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                "backend": args.backend, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "sources": {str(path.relative_to(ROOT)): digest(path) for path in inputs},
                "commands": commands, "results": records}
    (evidence / "results.json").write_text(json.dumps(metadata, indent=2) + "\n")
    lines = ["# Quint check evidence", "", f"Quint {QUINT_VERSION}; Apalache {APALACHE_VERSION}; {java_version}.",
             "", "Simulation is sampling, not proof. Apalache checks only the listed transition bound.",
             "TLC enumerates the finite harness: its turn counter stops at that bound; --max-steps itself does not bound TLC.",
             "Core explores arbitrary modeled actions for six transitions; other cases restrict schedules.",
             "", "| case | check | bound | expected | observed | seconds |", "|---|---|---:|---|---|---:|"]
    lines += [f"| {r['case']} | {r['kind']} | {r.get('bound', '?')} | {r.get('expected', '?')} | {r['observed']} | {r.get('seconds', '?')} |" for r in records]
    (evidence / "summary.md").write_text("\n".join(lines) + "\n")
    print("Evidence: " + str(evidence), flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
