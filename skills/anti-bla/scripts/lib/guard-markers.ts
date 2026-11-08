// Text shapes of BLA's runtime guards (BLA 3.1.0: src/shields/runtime/runtime-shield.ts,
// self-seal.ts, src/shields/exhaustion/cdp-shape-budget-breaker.ts, frida-capture-saturation.ts).
// Each one tests a signal an attached tool leaves: a Node inspector flag, a Playwright, Puppeteer,
// WebDriver or Frida global, or NODE_OPTIONS. The globals and flags are literal in BLA output.
// `strong` markers are BLA's own and fire the scan finding. Weak ones also occur in ordinary
// apps (bot detection), so they are located by runtime-guard.ts but never scored.
export interface GuardMarker {
  id: string;
  re: RegExp;
  strong: boolean;
  /** What the guard reads. */
  signal: "inspect-flag" | "cdp-global" | "frida-global" | "node-options" | "guard-function";
}

export const GUARD_MARKERS: readonly GuardMarker[] = [
  { id: "inspector_observed", re: /\binspectorObserved\b/, strong: true, signal: "guard-function" },
  { id: "cdp_breaker", re: /\bcdpShapeBudgetGuard_\w+/, strong: true, signal: "guard-function" },
  { id: "frida_saturator", re: /\bfrida(?:CaptureSaturator|RealmRing)_\w+/, strong: true, signal: "guard-function" },
  { id: "puppeteer_global", re: /__puppeteer_evaluation_script__/, strong: true, signal: "cdp-global" },
  { id: "playwright_global", re: /\b__playwright\b/, strong: false, signal: "cdp-global" },
  { id: "webdriver_flag", re: /navigator\??\.webdriver/, strong: false, signal: "cdp-global" },
  { id: "frida_global", re: /\b_frida_\b|\.Interceptor\b/, strong: false, signal: "frida-global" },
  { id: "inspect_flag", re: /includes\(\s*["']--(?:inspect|remote-debugging)/, strong: false, signal: "inspect-flag" },
  { id: "node_options_digest", re: /process\.env\.NODE_OPTIONS/, strong: false, signal: "node-options" },
];

/** One row per marker per line of `src` (1-based). */
export function findMarkers(src: string): { marker: GuardMarker; line: number }[] {
  const hits: { marker: GuardMarker; line: number }[] = [];
  src.split("\n").forEach((text, i) => {
    for (const marker of GUARD_MARKERS) if (marker.re.test(text)) hits.push({ marker, line: i + 1 });
  });
  return hits;
}

/** Count of BLA-own (strong) marker hits in `src`. */
export const countStrongMarkers = (src: string): number => findMarkers(src).filter((h) => h.marker.strong).length;
