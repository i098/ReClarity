"""Render two asciinema casts side by side at the same speed.
usage: render.py left.cast right.cast captions.json out.mp4
Idle gaps (no output on either pane for more than GAP s) are cut to GAP on both panes.
Frames are drawn from the casts with pyte + PIL; nothing else is edited."""
import json, subprocess, sys, bisect
import pyte
from PIL import Image, ImageDraw, ImageFont

GAP, FPS = 1.5, 10
COLS, ROWS = 100, 46
PW, PH = 960, 874
TOP, W, H = 54, 1920, 1080
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 15)
BOLD = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 22)
CAP = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 27)
CW, LH = 9.03, 19
BG, FG = (14, 16, 20), (205, 210, 218)
COL = {"AGENT:": (140, 220, 140), "RUN:": (110, 190, 255), "OUT:": (160, 165, 175),
       "HOOK:": (255, 190, 70), "END:": (200, 140, 255)}

def load(p):
    ev = []
    for i, l in enumerate(open(p)):
        if i == 0: continue
        t, k, d = json.loads(l)
        if k == "o": ev.append((t, d))
    return ev

def rowcolors(lines):
    out, cur = [], FG
    for s in lines:
        st = s.lstrip()
        if s[:1] == "[" and "]" in s[:8]:
            tag = s[s.index("]") + 2:].split(" ")[0]
            cur = COL.get(tag, FG)
        elif s.startswith("claude-opus") or s.startswith("FIRST MESSAGE") or s == "done":
            cur = (255, 255, 255)
        out.append(cur)
    return out

left, right, caps, outp = sys.argv[1:5]
caps = json.load(open(caps))
LE, RE = load(left), load(right)
times = sorted({t for t, _ in LE} | {t for t, _ in RE})
# video time of each event time: gaps over GAP are cut to GAP
vt, acc, prev = {}, 0.0, 0.0
for t in times:
    acc += min(t - prev, GAP); prev = t; vt[t] = acc
vend = acc + 6.0  # hold last frame 6 s
def real_at(v):  # real time shown at video time v
    ks = sorted(vt.items(), key=lambda kv: kv[1]); vs = [x[1] for x in ks]
    i = bisect.bisect_right(vs, v) - 1
    return ks[i][0] if i >= 0 else 0.0
KS = sorted(vt.items(), key=lambda kv: kv[1]); VS = [x[1] for x in KS]

class Pane:
    def __init__(s, ev):
        s.ev, s.i = ev, 0
        s.scr = pyte.Screen(COLS, ROWS); s.st = pyte.Stream(s.scr); s.img = None; s.dirty = True
    def advance(s, rt):
        while s.i < len(s.ev) and s.ev[s.i][0] <= rt:
            s.st.feed(s.ev[s.i][1]); s.i += 1; s.dirty = True
    def image(s):
        if s.dirty or s.img is None:
            im = Image.new("RGB", (PW, PH), BG); d = ImageDraw.Draw(im)
            lines = [s.scr.display[r].rstrip() for r in range(ROWS)]
            for r, (ln, c) in enumerate(zip(lines, rowcolors(lines))):
                d.text((24, 4 + r * LH), ln, font=FONT, fill=c)
            s.img, s.dirty = im, False
        return s.img

PL, PR = Pane(LE), Pane(RE)
titles = json.load(open(sys.argv[3]))["titles"]
ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
    "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", outp], stdin=subprocess.PIPE)
n = int(vend * FPS)
for f in range(n):
    v = f / FPS
    i = bisect.bisect_right(VS, v) - 1
    rt = KS[i][0] if i >= 0 else 0.0
    PL.advance(rt); PR.advance(rt)
    fr = Image.new("RGB", (W, H), (0, 0, 0)); d = ImageDraw.Draw(fr)
    fr.paste(PL.image(), (0, TOP)); fr.paste(PR.image(), (960, TOP))
    d.rectangle([958, 0, 961, H], fill=(70, 74, 82))
    for x, side in ((0, "left"), (960, "right")):
        d.rectangle([x, 0, x + 959, TOP - 1], fill=(30, 34, 42))
        d.text((x + 24, 12), titles[side], font=BOLD, fill=(255, 255, 255))
        d.text((x + 800, 18), "real %d:%02d" % (rt // 60, rt % 60), font=FONT, fill=(255, 190, 70))
        txt = [c["text"] for c in caps["captions"] if c["side"] == side and c["from"] <= rt < c["to"]]
        if not txt:
            d.text((x + 28, TOP + PH + 22), "Same prompt, same model, started together.", font=FONT, fill=(150, 155, 165))
            d.text((x + 28, TOP + PH + 44), "Same playback speed. Waits over 1.5 s are cut on both panes.", font=FONT, fill=(150, 155, 165))
        if txt:
            d.rectangle([x + 12, TOP + PH + 10, x + 947, H - 10], fill=(255, 214, 10))
            y = TOP + PH + 18
            for ln in txt[-1].split("\n"):
                d.text((x + 28, y), ln, font=CAP, fill=(0, 0, 0)); y += 36
    ff.stdin.write(fr.tobytes())
ff.stdin.close(); ff.wait()
print("frames", n, "video s", n / FPS, "real end", times[-1])
