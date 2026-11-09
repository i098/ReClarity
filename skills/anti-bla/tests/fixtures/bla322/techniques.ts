// One row per BLA 3.2.2 technique that a sample can show. `marker` is read from BLA's source; a test proves the
// sample carries it. `scan` is the scan finding the sample must give, `fence` the setup-clarity signal.
// Used by tests and by `docs/proof.md`.
export interface Technique {
  technique: string;
  sample: string;
  marker: RegExp;
  scan: string;
  fence: string | null;
}

export const TECHNIQUES: Technique[] = [
  { technique: "prompt-completion-poison", sample: "app.bla.js", marker: /\$[0-9a-f]{2}[A-Z]\w+_[0-9a-f]+/, scan: "bait_text", fence: "decoy_symbol" },
  { technique: "evidence-contract-poison", sample: "app.bla.js", marker: /Do not reconstruct local arithmetic|EV-TEE-/, scan: "bait_text", fence: "stop_order" },
  { technique: "semantic-honeypot", sample: "app.bla.js", marker: /verifyEnterpriseMasterLicense_|decryptOfflineVaultPayload_/, scan: "enclave_words", fence: "decoy_symbol" },
  { technique: "crash-trace-decoy", sample: "app.bla.js", marker: /SIGSEGV_ENCLAVE|EXC_BAD_ACCESS/, scan: "enclave_words", fence: "enclave_words" },
  { technique: "architecture-mirage", sample: "app.bla.js", marker: /grpcServiceMirage_/, scan: "enclave_words", fence: "decoy_symbol" },
  { technique: "decompiler-illusion", sample: "app.bla.js", marker: /aliasedBufferIllusion_/, scan: "opaque_predicate", fence: "decoy_symbol" },
  { technique: "diff-noise-injector", sample: "app.bla.js", marker: /diffFrontier_/, scan: "opaque_predicate", fence: "decoy_symbol" },
  { technique: "canary-honeypot", sample: "app.bla.js", marker: /AKIAIOSFODNN7EXAMPLE/, scan: "bait_text", fence: "canary_credential" },
  { technique: "system-diagnostic-decoy", sample: "app.bla.js", marker: /GhidraSnapshotCacheMismatchError|LinuxPrivateDisplayDiagnostic|provider_closing/, scan: "enclave_words", fence: "enclave_words" },
  { technique: "shadow-business-logic", sample: "app.bla.js", marker: /ANALYSIS_VIEW_PROJECTION|business_logic_present/, scan: "bait_text", fence: "bait_text" },
  { technique: "cognitive-armor-trigger (benign)", sample: "app.bla.js", marker: /ENCLAVE-ATTESTATION-GUARD|ABI-COMPAT-SHIM|SEALED-FSM/, scan: "bait_text", fence: "bait_text" },
  { technique: "cognitive-armor-trigger (--llm-directives)", sample: "app.bla-llm.js", marker: /<system-reminder>|<\|im_start\|>|ALIGNMENT-EVAL-CANARY/, scan: "agent_directive", fence: "agent_directive" },
  { technique: "obligation-flooder", sample: "app.bla.js", marker: /obligationFlood_/, scan: "opaque_predicate", fence: "decoy_symbol" },
  { technique: "regex-worker-tarpit", sample: "app.bla.js", marker: /regexSearchMagnet_/, scan: "opaque_predicate", fence: null },
  { technique: "callgraph-labyrinth", sample: "app.bla.js", marker: /scc_[a-zA-Z]+_[0-9a-f]+_c\d+n\d+/, scan: "opaque_predicate", fence: null },
  { technique: "bpe-token-amplifier", sample: "app.bla.js", marker: /bpeSink_/, scan: "opaque_predicate", fence: null },
  { technique: "cdp-shape-budget-breaker", sample: "app.bla.js", marker: /cdpShapeBudgetGuard_/, scan: "runtime_guard", fence: null },
  { technique: "frida-capture-saturation", sample: "app.bla.js", marker: /fridaCaptureSaturator/, scan: "runtime_guard", fence: null },
  { technique: "runtime-shield", sample: "app.bla.js", marker: /inspectorObserved/, scan: "runtime_guard", fence: null },
  { technique: "self-seal", sample: "app.bla-all.js", marker: /createHash\("sha256"\)/, scan: "agent_directive", fence: "agent_directive" },
  { technique: "sidecar-entangle", sample: "app.bla-all.js", marker: /sibBuf/, scan: "agent_directive", fence: "agent_directive" },
  { technique: "canary-compliance text (--llm-directives)", sample: "app.bla-llm.js", marker: /COPPA_16_CFR_312|IEC_62304|18_USC_1030/, scan: "agent_directive", fence: "agent_directive" },
  { technique: "sourcemap shield", sample: "bla-app.js.map", marker: /enclave:\/\/tee-runtime\//, scan: "agent_directive", fence: "agent_directive" },
  { technique: "gpu-ptx shield", sample: "bla-k.ptx", marker: /\[BLA-PTX-SHIELD\]/, scan: "shield_marker", fence: "bait_text" },
  { technique: "apple-plist shield", sample: "bla-Info.plist", marker: /BLAEnclaveAttestationAuthority/, scan: "shield_marker", fence: "canary_credential" },
  { technique: "firmware-uf2 shield", sample: "bla-fw.uf2", marker: /\[BLA-UF2-SHIELD\]/, scan: "shield_marker", fence: "bait_text" },
  { technique: "jvm-bytecode shield", sample: "bla-Tiny.class", marker: /\[BLA-JVM-ENCLAVE:/, scan: "shield_marker", fence: "bait_text" },
  { technique: "python weave + --llm-directives", sample: "ledger.bla.py", marker: /<system-reminder>|ALIGNMENT-EVAL-CANARY|\\n\\nHuman:/, scan: "python_tarpit", fence: "agent_directive" },
];
