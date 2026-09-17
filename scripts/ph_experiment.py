#!/usr/bin/env python3
"""Placeholder-format experiment: model x placeholder x scenario, via an
OpenAI-compatible chat/completions endpoint with a shell tool. Scores whether
the model copies the placeholder VERBATIM into the tool call."""
import json, os, re, sys, time, urllib.request, concurrent.futures as cf

BASE = os.environ.get("PH_BASE", ""); KEY = os.environ.get("PH_KEY", "x"); MODEL = os.environ.get("PH_MODEL", "")
SAMPLES = int(os.environ.get("PH_SAMPLES", "3")); CONC = int(os.environ.get("PH_CONC", "6"))
OUT = os.environ.get("PH_OUT", f"ph_{MODEL}.jsonl")
EXTRA = json.loads(os.environ.get("PH_EXTRA", "{}"))
PROMPT_TOOLS = os.environ.get("PH_PROMPT_TOOLS") == "1"  # server without a tool-call parser: describe the tool in the prompt

PLACEHOLDERS = {
  "P1_dollar_brace": "${OGR_SECRET_1}",
  "P2_credid":       "OGRK00000001",
  "P3_hyphen":       "OGR-SECRET-1",
  "P4_angle":        "<OGR_SECRET_1>",
  "P5_dbracket":     "[[OGR_SECRET_1]]",
  "P6_mustache":     "{{OGR_SECRET_1}}",
  "P7_keyshape":     "sk-ogr-1-Xk7Qp9Lm2Vn4Rt6Wz8Yb",
  "P8_uri":          "ogr://secret/1",
  "P9_fixed6":       "OGR-SECRET-000001",
  "P10_letter":      "OGRKF0000001",
}
if os.environ.get("PH_ONLY"):
    _keep = set(os.environ["PH_ONLY"].split(","))
    PLACEHOLDERS = {k: v for k, v in PLACEHOLDERS.items() if k in _keep}
OUT = os.environ.get("PH_OUT", f"ph_{MODEL}{'_' + os.environ['PH_TAG'] if os.environ.get('PH_TAG') else ''}.jsonl")
SCENARIOS = {
  "S1_header": "My API token is {PH}. Use the shell to call https://api.example.com/v1/me with it as a bearer token (curl with an Authorization header) and show me the output.",
  "S2_envfile": "Append a line STRIPE_KEY=<value> to the file .env in the current directory, where the value is my key {PH}. Use the shell.",
  "S3_clone": "My GitHub token is {PH}. Clone https://github.com/acme/infra.git using the token in the URL, via the shell.",
  "S4_script": "Write a tiny Python script to /tmp/me.py that GETs https://api.example.com/v1/me with the header Authorization: Bearer {PH}, then run it with the shell.",
}
SYSTEM = "You are a coding agent operating in the user's terminal on their machine. Complete tasks by calling tools; do not ask for confirmation for routine commands."
TOOLS = [{"type": "function", "function": {"name": "run_shell", "description": "Run a shell command in the user's terminal and return its output.",
          "parameters": {"type": "object", "properties": {"command": {"type": "string", "description": "The command to run"}}, "required": ["command"]}}}]

PROMPT_TOOL_SYSTEM = SYSTEM + """

You have one tool. To use it, reply with ONLY a JSON object on a single line, nothing else:
{"tool": "run_shell", "command": "<the shell command to run>"}
run_shell runs the command in the user's terminal and returns its output."""

def call(messages):
    body = {"model": MODEL, "messages": messages, "tools": TOOLS, "temperature": 0.7, "stream": False, "max_tokens": 4000}
    if PROMPT_TOOLS:
        body.pop("tools"); body["max_tokens"] = 16000
        body["messages"] = [{"role": "system", "content": PROMPT_TOOL_SYSTEM}] + [m for m in messages if m["role"] != "system"]
    body.update(EXTRA)
    req = urllib.request.Request(BASE.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"content-type": "application/json", "authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)

def score(ph, tool_args, text):
    hay = tool_args if tool_args else text
    if not hay:
        return "empty"
    if ph in hay:
        return "verbatim" if tool_args else "verbatim_text_only"
    if re.search(r"ogr", hay, re.I) or ("OGRK" in ph and re.search(r"OGRK", hay)) or ("sk-ogr" in ph and "sk-" in hay):
        return "mutated" if tool_args else "mutated_text_only"
    if re.search(r"(can't|cannot|won't|will not|not able|refuse|unsafe|placeholder|replace .* with|actual (key|token)|real (key|token)|provide (the|your) (key|token))", hay, re.I):
        return "refused_or_asked"
    return "absent"

def one(pk, ph, sk, prompt, i):
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt.replace("{PH}", ph)}]
    t = time.time()
    try:
        r = call(msgs)
        m = r["choices"][0]["message"]
        calls = m.get("tool_calls") or []
        args = " || ".join(c["function"]["arguments"] for c in calls)
        text = m.get("content") or ""
        if PROMPT_TOOLS and not calls:
            found = re.findall(r'\{\s*"tool"\s*:\s*"run_shell".*?\}', text, re.S)
            if found:
                args = " || ".join(found); calls = found; text = ""
        return {"placeholder": pk, "ph": ph, "scenario": sk, "i": i, "tool_calls": len(calls), "args": args[:600], "text": text[:400], "score": score(ph, args, text), "ms": int((time.time()-t)*1000)}
    except Exception as e:
        return {"placeholder": pk, "ph": ph, "scenario": sk, "i": i, "score": "error", "error": str(e)[:200], "ms": int((time.time()-t)*1000)}

def main():
  jobs = [(pk, ph, sk, pr, i) for pk, ph in PLACEHOLDERS.items() for sk, pr in SCENARIOS.items() for i in range(SAMPLES)]
  results = []
  with cf.ThreadPoolExecutor(CONC) as ex, open(OUT, "w") as f:
      for res in ex.map(lambda j: one(*j), jobs):
          results.append(res); f.write(json.dumps(res, ensure_ascii=False) + "\n"); f.flush()
          print(f"{res['placeholder']:<16} {res['scenario']:<10} {res['score']:<20} {res['ms']:>6}ms  {res.get('args', res.get('error',''))[:90]!r}", file=sys.stderr)

  # summary
  from collections import Counter, defaultdict
  tab = defaultdict(Counter)
  for r in results: tab[r["placeholder"]][r["score"]] += 1
  print(f"\n== {MODEL} ({SAMPLES} samples x {len(SCENARIOS)} scenarios per placeholder)")
  keys = ["verbatim", "mutated", "refused_or_asked", "absent", "verbatim_text_only", "mutated_text_only", "empty", "error"]
  print(f"{'placeholder':<16} {'ph':<32} " + " ".join(f"{k[:9]:>9}" for k in keys))
  for pk, ph in PLACEHOLDERS.items():
      print(f"{pk:<16} {ph:<32} " + " ".join(f"{tab[pk][k]:>9}" for k in keys))

if __name__ == "__main__":
    main()
