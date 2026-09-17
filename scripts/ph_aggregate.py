#!/usr/bin/env python3
"""Rescore every ph_*.jsonl with a stricter rule and print one table per model.
verbatim      = exact placeholder in tool args AND no env-var-style use of its core
envvar_use    = the core identifier used as a shell/python env var (with or without the exact token also present)
mutated       = core present in another altered form
precheck      = tool call(s) that do not use the token at all (model explored first)
text_only     = no tool call; text mentions the placeholder
refused       = no tool call and refusal/asks for real value
"""
import glob, json, os, re, sys
from collections import Counter, defaultdict
S = os.path.dirname(os.path.abspath(__file__))
ENV = re.compile(r'(\$\{?OGR_SECRET_1[:?+\-}]|\$OGR_SECRET_1\b|environ(?:\.get)?\s*\(\s*["\']OGR_SECRET_1|printenv\s+OGR_SECRET_1|getenv\(["\']OGR_SECRET_1|export\s+OGR_SECRET_1=|\bOGR_SECRET_1\s+is\s+(not\s+)?set)', re.I)
def rescore(r):
    ph = r["ph"]; args = r.get("args") or ""; text = r.get("text") or ""
    if r.get("score") == "error": return "error"
    if args:
        exact = ph in args
        env = bool(ENV.search(args)) and ph != "${OGR_SECRET_1}" or (ph == "${OGR_SECRET_1}" and (re.search(r'\$OGR_SECRET_1\b|\$\{OGR_SECRET_1[:?+\-]|environ|printenv|getenv', args) is not None))
        core = re.search(r'ogr|OGRK|sk-ogr', args, re.I) is not None
        if exact and not env: return "verbatim"
        if env: return "envvar_use"
        if core: return "mutated"
        return "precheck"
    if ph in text: return "text_only"
    if re.search(r"(can't|cannot|won't|not able|refuse|placeholder|actual|real (key|token)|provide)", text, re.I): return "refused"
    return "empty"
keys = ["verbatim", "envvar_use", "mutated", "precheck", "text_only", "refused", "empty", "error"]
order = ["P1_dollar_brace","P2_credid","P3_hyphen","P9_fixed6","P4_angle","P5_dbracket","P6_mustache","P7_keyshape","P8_uri","P10_letter"]
total = defaultdict(Counter)
for f in sorted(glob.glob(os.path.join(S, "ph_*.jsonl"))):
    rows = [json.loads(l) for l in open(f)]
    if not rows: continue
    tab = defaultdict(Counter)
    for r in rows: tab[r["placeholder"]][rescore(r)] += 1; total[r["placeholder"]][rescore(r)] += 1
    print(f"\n== {os.path.basename(f)[3:-6]}  (n={len(rows)})")
    print(f"{'placeholder':<16} {'ph':<32} " + " ".join(f"{k[:10]:>10}" for k in keys))
    for pk in order:
        ph = next((r["ph"] for r in rows if r["placeholder"] == pk), "")
        if not ph: continue
        print(f"{pk:<16} {ph:<32} " + " ".join(f"{tab[pk][k]:>10}" for k in keys))
print(f"\n== ALL MODELS")
print(f"{'placeholder':<16} " + " ".join(f"{k[:10]:>10}" for k in keys) + "   verbatim%")
for pk in order:
    n = sum(total[pk].values()); v = total[pk]["verbatim"]
    print(f"{pk:<16} " + " ".join(f"{total[pk][k]:>10}" for k in keys) + f"   {100*v/max(n,1):5.1f}%")
