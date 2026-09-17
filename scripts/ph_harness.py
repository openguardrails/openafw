#!/usr/bin/env python3
"""Drive a coding-agent harness (claude / codex) over the placeholder matrix and score tool-call verbatim copies."""
import json, os, re, subprocess, sys, concurrent.futures as cf
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from ph_experiment import PLACEHOLDERS, SCENARIOS, score  # noqa
HARNESS = sys.argv[1]; MODEL = sys.argv[2] if len(sys.argv) > 2 else ""; SAMPLES = int(os.environ.get("PH_SAMPLES", "1")); CONC = int(os.environ.get("PH_CONC", "4"))
S = os.path.dirname(os.path.abspath(__file__)); CWD = os.path.join(S, f"{HARNESS}_cwd"); os.makedirs(CWD, exist_ok=True)
env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}

def run(pk, ph, sk, prompt, i):
    p = prompt.replace("{PH}", ph)
    if HARNESS == "claude":
        cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--allowedTools", "Bash,Write", "--max-turns", "3"] + (["--model", MODEL] if MODEL else []) + [p]
    else:
        cmd = ["codex", "exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", CWD] + (["-m", MODEL] if MODEL else []) + [p]
    try:
        out = subprocess.run(cmd, cwd=CWD, env=env, capture_output=True, text=True, timeout=300).stdout
    except subprocess.TimeoutExpired:
        return {"placeholder": pk, "ph": ph, "scenario": sk, "i": i, "score": "error", "error": "timeout"}
    args, text = [], []
    ARG_KEYS = {"command", "arguments", "input", "file_path", "content"}; TEXT_KEYS = {"text"}
    def walk(v, key=None, in_tool=False):
        if isinstance(v, dict):
            tool = in_tool or v.get("type") in ("tool_use", "command_execution", "function_call", "custom_tool_call")
            for k, x in v.items(): walk(x, k, tool)
        elif isinstance(v, list):
            for x in v: walk(x, key, in_tool)
        elif isinstance(v, str):
            if in_tool and key in ARG_KEYS: args.append(v)
            elif key in TEXT_KEYS: text.append(v)
    for line in out.splitlines():
        try: ev = json.loads(line)
        except Exception: continue
        if HARNESS == "claude" and ev.get("type") != "assistant": continue
        if HARNESS == "codex" and not str(ev.get("type", "")).startswith("item."): continue
        walk(ev)
    a = " || ".join(args); tx = "\n".join(text)
    return {"placeholder": pk, "ph": ph, "scenario": sk, "i": i, "tool_calls": len(args), "args": a[:600], "text": tx[:400], "score": score(ph, a, tx)}

jobs = [(pk, ph, sk, pr, i) for pk, ph in PLACEHOLDERS.items() for sk, pr in SCENARIOS.items() for i in range(SAMPLES)]
results = []
TAG = ("_" + os.environ["PH_TAG"]) if os.environ.get("PH_TAG") else ""
with cf.ThreadPoolExecutor(CONC) as ex, open(os.path.join(S, f"ph_{HARNESS}_{MODEL or 'default'}{TAG}.jsonl"), "w") as f:
    for r in ex.map(lambda j: run(*j), jobs):
        results.append(r); f.write(json.dumps(r, ensure_ascii=False) + "\n"); f.flush()
        print(f"{r['placeholder']:<16} {r['scenario']:<10} {r['score']:<20} {r.get('args', r.get('error',''))[:90]!r}", file=sys.stderr)
tab = defaultdict(Counter)
for r in results: tab[r["placeholder"]][r["score"]] += 1
keys = ["verbatim", "mutated", "refused_or_asked", "absent", "verbatim_text_only", "mutated_text_only", "empty", "error"]
print(f"\n== {HARNESS} {MODEL} ({SAMPLES} x {len(SCENARIOS)} scenarios)")
print(f"{'placeholder':<16} {'ph':<32} " + " ".join(f"{k[:9]:>9}" for k in keys))
for pk, ph in PLACEHOLDERS.items(): print(f"{pk:<16} {ph:<32} " + " ".join(f"{tab[pk][k]:>9}" for k in keys))
