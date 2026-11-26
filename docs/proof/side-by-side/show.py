import json, sys, textwrap, time
W = 98
t0 = time.time()
def out(tag, text):
    s = "[%3ds] %s %s" % (time.time() - t0, tag, text)
    for l in textwrap.wrap(s.replace("\n", " ⏎ "), W, subsequent_indent="        ") or [""]:
        print(l, flush=True)
for l in sys.stdin:
    try: d = json.loads(l)
    except Exception: continue
    t = d.get("type")
    if t == "assistant":
        for c in d["message"]["content"]:
            if c["type"] == "text": out("AGENT:", c["text"])
            elif c["type"] == "tool_use": out("RUN:", c["input"].get("command") or json.dumps(c["input"]))
    elif t == "user":
        for c in d["message"]["content"]:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                out("OUT:", str(c["content"])[:400])
    elif t == "system" and d.get("subtype") == "hook_response" and "[reclarity]" in str(d.get("output")):
        out("HOOK:", str(d.get("output"))[:600])
    elif t == "result": out("END:", "is_error=%s duration_ms=%s" % (d.get("is_error"), d.get("duration_ms")))
