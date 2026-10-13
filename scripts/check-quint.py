#!/usr/bin/env python3
"""Check synthetic Quint specifications, never a real vault or GitHub repository."""
import argparse
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
import time

ROOT = Path(__file__).resolve().parents[1]
FORMAL = ROOT / "formal" / "quint"
QUINT_VERSION = "0.33.0"
APALACHE_VERSION = "0.62.1"
JAR_SHA256 = "880c0b2b72354816f12e9a9755829f2907071e9a181ffea1937954c23d54739d"
# module, schedule depth, expected result, exact property for negative control
TEMPORAL = {"NativeHandoff": "progress", "LedgerDiverged": "progress", "NativeReplace": "progress", "NativeDelete": "progress", "NativeCreate": "progress", "NativeText": "progress", "Ledger": "progress", "NegLedgerUnfair": "progress", "LiveIndependent": "convergence", "LiveConflict": "convergence", "NegUnfair": "convergence"}
FULL_GRAPH = {"NegTornPublish", "NegIssueAck", "NegIssueEdit", "NegAttemptFlag", "NegNativeClobber", "NegNativeRehash", "NegPrefixGuess", "NegLedgerAbsent", "NegLedgerSplit", "NegLedgerAnchor", "NegSealAnchor", "NegLedgerJournal", "NegLedgerReplay","Durability", "NegVolatileObservation", "NegApprovalScope", "NegNativeGuard", "NegAccountCapture"}
SCENARIOS = {"ConsentVersions", "LedgerPublishWins", "LedgerSealWins", "Independent", "ResponseLoss", "UnknownRewind", "ExactPublish", "Application", "StaleDecision", "UseRemote", "SilentDraft", "Adoption"}
CASES = [
    ("NativeHandoff", 0, "PASS", "safe"),
    ("NegTornPublish", 16, "VIOLATION", "noAutoUnknown"),
    ("NegIssueAck", 16, "VIOLATION", "ackBacked"),
    ("NegIssueEdit", 16, "VIOLATION", "noAutoUnknown"),
    ("NegAttemptFlag", 16, "VIOLATION", "attemptBeforeEffect"),
    ("LedgerDiverged", 0, "PASS", "safeUnderTamper"),
    ("ConsentVersions", 14, "PASS", "safe"),
    ("LedgerPublishWins", 16, "PASS", "safe"),
    ("LedgerSealWins", 16, "PASS", "safe"),
    ("NativeReplace", 0, "PASS", "safe"),
    ("NativeDelete", 0, "PASS", "safe"),
    ("NativeCreate", 0, "PASS", "safe"),
    ("NativeText", 0, "PASS", "safe"),
    ("NegNativeClobber", 15, "VIOLATION", "exact"),
    ("NegNativeRehash", 15, "VIOLATION", "writerPreserved"),
    ("NegPrefixGuess", 15, "VIOLATION", "writerPreserved"),
    ("Ledger", 0, "PASS", "safe"),
    ("NegLedgerUnfair", 0, "VIOLATION", "safe"),
    ("NegLedgerAbsent", 20, "VIOLATION", "verdictSound"),
    ("NegLedgerSplit", 20, "VIOLATION", "atomicPublication"),
    ("NegLedgerAnchor", 20, "VIOLATION", "exclusive"),
    ("NegSealAnchor", 20, "VIOLATION", "exclusive"),
    ("NegLedgerJournal", 20, "VIOLATION", "journalFirst"),
    ("NegLedgerReplay", 20, "VIOLATION", "noReplay"),
    ("Adoption", 10, "PASS", "safe and completed"),
    ("ProbeOptimisticLoss", 13, "PASS", "latestSavePreserved"),
    ('UseRemote', 8, 'PASS', 'safe and completed'),
    ('SilentDraft', 9, 'PASS', 'safe and completed'),
    ('NegDiscardRemote', 8, 'VIOLATION', 'latestSavePreserved'),
    ('NegSilentDraft', 9, 'VIOLATION', 'noBlindOverwrite'),
    ('NegReplayUnique', 7, 'VIOLATION', 'noReplay'),
    ('NegUnauthored', 7, 'VIOLATION', 'noUnauthoredChange'),
    ('NegOptimistic', 13, 'VIOLATION', 'checkpointPublished'),

    ("Durability", 15, "PASS", "safe"),
    ("NegVolatileObservation", 15, "VIOLATION", "approvalDurable"),
    ("NegApprovalScope", 15, "VIOLATION", "approvalScoped"),
    ("NegNativeGuard", 15, "VIOLATION", "newerPreserved"),
    ("NegAccountCapture", 15, "VIOLATION", "accountedCaptured"),
    ("LiveIndependent", 0, "PASS", "safe"),
    ("LiveConflict", 0, "PASS", "safe"),
    ("NegUnfair", 0, "VIOLATION", "safe"),
    ("Core", 5, "PASS", "safe"),
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
    process = subprocess.Popen(command, cwd=FORMAL, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
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



def classify(code, output, verification=False, temporal=False, backend=None):
    """Only the pinned CLI's normal success/counterexample exits are verdicts."""
    if temporal:
        if backend != "tlc":
            return "ERROR"
        if code == 0 and "[ok]" in output and "Model checking completed. No error has been found." in output and "Checking temporal properties" in output:
            return "PASS"
        if code == 1 and "Error: Temporal property q_temporalProps was violated." in output and "found a counterexample" in output:
            return "VIOLATION"
        return "ERROR"
    if verification and backend == "tlc":
        if code == 0 and "[ok]" in output and "Model checking completed. No error has been found." in output:
            return "PASS"
        if code == 1 and "Error: Invariant q_inv is violated." in output and "found a counterexample" in output:
            return "VIOLATION"
        return "ERROR"
    if code == 0 and "[ok]" in output:
        return "PASS"
    if code == 1 and ("Invariant violated" in output or
                      (verification and "found a counterexample" in output)):
        return "VIOLATION"
    return "ERROR"


def java_env():
    env = dict(os.environ)
    candidates = [shutil.which("java")]
    if env.get("JAVA_HOME"):
        candidates.insert(0, str(Path(env["JAVA_HOME"]) / "bin" / "java"))
    if Path("/usr/libexec/java_home").exists():
        found = subprocess.run(["/usr/libexec/java_home", "-v", "21+"], capture_output=True, text=True)
        if found.returncode == 0:
            candidates.insert(0, str(Path(found.stdout.strip()) / "bin" / "java"))
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
        if "dev" not in protocol or "event" not in protocol:
            lines.append(f"State {state['#meta']['index']}: " + json.dumps(protocol, sort_keys=True))
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
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    selected = [case for case in CASES if not args.only or case[0] in args.only]
    if any(case[0] in TEMPORAL for case in selected) and (args.simulate_only or args.backend != "tlc"):
        parser.error("Temporal cases require TLC; select safety cases with --only for simulation/Apalache")
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
    lock = (evidence / ".runner.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another runner owns this evidence directory; refusing to overwrite it")
    sources = [path for path in sorted(FORMAL.rglob("*.qnt"))
               if not any(part in path.parts for part in ["node_modules", ".tools", "_generated", "_apalache-out"])]
    inputs = sources + [FORMAL / "package-lock.json", FORMAL / "package.json", FORMAL / "tlc-config.json",
                        Path(__file__).resolve(), ROOT / "scripts/test-check-quint.py", ROOT / "scripts/check-model.sh"]
    source_hashes = {str(path.relative_to(ROOT)): digest(path) for path in inputs}
    (evidence / "results.json").write_text(json.dumps({"status": "RUNNING", "sources": source_hashes}) + "\n")
    (evidence / "summary.md").write_text("# Check in progress\n\nNo completed verdict for this invocation.\n")
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
    records = []
    commands = []
    bad = False
    for name, bound, expected, invariant in selected:
        for suffix in ["typecheck.log", "verify.log", "simulation.log", "simulation.itf.json", "simulation.itf.txt"]:
            (evidence / f"{name}.{suffix}").unlink(missing_ok=True)
        source = f"models/{name}.qnt"
        code, output = run([str(q), "typecheck", source], env, args.timeout)
        (evidence / f"{name}.typecheck.log").write_text(f"exit={code}\n" + output)
        if code != 0:
            bad = True
            records.append({"case": name, "kind": "typecheck", "observed": "ERROR", "exit": code})
            print(f"{name}: TYPECHECK ERROR", flush=True)
            continue
        if name not in TEMPORAL:
            simulation_itf = evidence / f"{name}.simulation.itf.json"
            simulation_itf.unlink(missing_ok=True)
            simulation_itf.with_suffix(".txt").unlink(missing_ok=True)
            simulation = [str(q), "run", source, "--backend=typescript", "--max-samples=10000",
                          f"--max-steps={bound}", "--seed=0x123456", f"--invariant={invariant}",
                          f"--out-itf={simulation_itf}", "--verbosity=1"]
            if expected == "PASS" and name in SCENARIOS:
                simulation.append("--witnesses=witness")
            start = time.monotonic()
            code, output = run(simulation, env, args.timeout)
            (evidence / f"{name}.simulation.log").write_text(f"exit={code}\n" + output)
            readable_trace(simulation_itf)
            observed = classify(code, output)
            witnesses = re.search(r'witness was witnessed in (\d+) trace\(s\) out of (\d+) explored', output)
            nonvacuous = expected != "PASS" or name not in SCENARIOS or (witnesses and witnesses[1] == witnesses[2] and int(witnesses[1]) > 0)
            valid = observed == expected and bool(nonvacuous)
            bad |= not valid
            records.append({"case": name, "kind": "simulation", "property": invariant, "bound": bound, "expected": expected,
                            "observed": observed, "valid": valid, "exit": code, "seconds": round(time.monotonic() - start, 2),
                            "witnesses": witnesses[0] if witnesses else None})
            commands.append(simulation)
            print(f"{name}: simulation {observed} ({'OK' if valid else 'MISMATCH'})", flush=True)
            if args.simulate_only:
                continue
        verify = [str(q), "verify", source, f"--backend={args.backend}", f"--max-steps={bound}",
                  f"--invariant={invariant}", f"--apalache-version={APALACHE_VERSION}",
                  f"--server-endpoint=localhost:{available_port()}", "--verbosity=3"]
        if name in TEMPORAL:
            verify.append(f"--temporal={TEMPORAL[name]}")
        if args.backend == "tlc":
            verify.append("--tlc-config=tlc-config.json")
        else:
            # TLC currently reports its counterexample in the raw log. Apalache
            # supports machine-readable ITF; preserve it without suppressing logs.
            pass
        start = time.monotonic()
        code, output = run(verify, env, args.timeout)
        (evidence / f"{name}.verify.log").write_text(f"exit={code}\n" + output)
        observed = classify(code, output, verification=True, temporal=name in TEMPORAL, backend=args.backend)
        valid = observed == expected
        bad |= not valid
        states = re.search(r'(\d+) states generated, (\d+) distinct states found', output)
        records.append({"case": name, "kind": args.backend, "property": invariant, "temporal": TEMPORAL.get(name), "bound": None if name in TEMPORAL or (args.backend == "tlc" and name in FULL_GRAPH) else bound, "expected": expected,
                        "observed": observed, "valid": valid, "exit": code,
                        "seconds": round(time.monotonic() - start, 2),
                        "states": states[0] if states else None})
        commands.append(verify)
        print(f"{name}: {args.backend} {observed} ({'OK' if valid else 'MISMATCH'})", flush=True)
    unchanged = all(path.exists() and digest(path) == source_hashes[str(path.relative_to(ROOT))] for path in inputs)
    bad |= not unchanged
    metadata = {"status": "FAIL" if bad else "PASS", "inputsUnchanged": unchanged,
                "fullSuite": not args.only and not args.simulate_only, "selected": [case[0] for case in selected], "quint": QUINT_VERSION, "apalache": APALACHE_VERSION, "apalacheJarSha256": JAR_SHA256,
                "java": java_version, "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                "backend": args.backend, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "sources": source_hashes,
                "commands": commands, "results": records}
    (evidence / "results.json").write_text(json.dumps(metadata, indent=2) + "\n")
    lines = ["# Quint check evidence", "", f"Quint {QUINT_VERSION}; Apalache {APALACHE_VERSION}; {java_version}.",
             "", "Simulation is sampling, not proof. Apalache checks only the listed transition bound.",
             "TLC enumerates each finite graph; only scenario/Core harnesses have a turn cutoff. --max-steps does not bound TLC.",
             "Core explores arbitrary modeled actions for five transitions; scenario cases restrict schedules.",
             "Ledger, native, progress, and durability graphs have no transition cutoff; temporal properties are identified in results.json.",
             "Null bounds mean no transition cutoff; the state space still has finite data/event budgets.",
             f"Invocation status: {metadata['status']}; unchanged inputs: {unchanged}; full suite: {metadata['fullSuite']}.",
             "", "| case | check | bound | expected | observed | seconds |", "|---|---|---:|---|---|---:|"]
    lines += [f"| {r['case']} | {r['kind']} | {r.get('bound', '?')} | {r.get('expected', '?')} | {r['observed']} | {r.get('seconds', '?')} |" for r in records]
    (evidence / "summary.md").write_text("\n".join(lines) + "\n")
    print("Evidence: " + str(evidence), flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
