// BLA 3.1.0 PCAP shield appends packets to a classic libpcap file: HTTP-like TCP packets (10.0.0.1 ->
// 10.0.0.2:80, `GET /bla/tarpit/exhaust`) and deep-label DNS-like UDP packets (port 1337 -> 53), each
// carrying `[BLA-PCAP-SHIELD]`. tshark expands them past REA's 8 MiB JSON limit. The original records stay
// byte for byte. A record is dropped only when its whole shape matches, never on the marker alone.
// BLA 3.1.0 never writes pcapng: given one, it throws the capture away and writes a fresh classic header with its
// own packets. Only classic libpcap is handled.

const MARKER = Buffer.from("[BLA-PCAP-SHIELD]", "utf8");
const HTTP_LINE = Buffer.from("GET /bla/tarpit/exhaust HTTP/1.1\r\nHost: enclave.internal\r\nUser-Agent: BLA-PCAP-Shield/1.0\r\n[BLA-PCAP-SHIELD] canary=", "utf8");
const DNS_BAIT = Buffer.from("\n[BLA-PCAP-SHIELD]\n", "utf8");
const ETH = 14;
const IP = 20;

interface PcapLayout {
  le: boolean;
  linktype: number;
}

/** Classic pcap magic in any of the four forms (micro/nano, either byte order). */
export function pcapLayout(head: Buffer): PcapLayout | undefined {
  if (head.length < 24) return undefined;
  const be = head.readUInt32BE(0);
  if (be === 0xa1b2c3d4 || be === 0xa1b23c4d) return { le: false, linktype: head.readUInt32BE(20) };
  if (be === 0xd4c3b2a1 || be === 0x4d3cb2a1) return { le: true, linktype: head.readUInt32LE(20) };
  return undefined;
}

const ipIs = (f: Buffer, at: number, a: number[]): boolean => a.every((b, i) => f[at + i] === b);

/** True for a frame BLA built: Ethernet/IPv4 10.0.0.1 -> 10.0.0.2 with its fixed TCP or UDP shape and marker. */
export function isShieldFrame(f: Buffer): boolean {
  if (f.length < ETH + IP + 8 || f[12] !== 0x08 || f[13] !== 0x00 || f[ETH] !== 0x45) return false;
  if (!ipIs(f, ETH + 12, [10, 0, 0, 1]) || !ipIs(f, ETH + 16, [10, 0, 0, 2])) return false;
  const proto = f[ETH + 9];
  const l4 = ETH + IP;
  if (proto === 6) return f.readUInt16BE(l4 + 2) === 80 && f.subarray(l4 + 20, l4 + 20 + HTTP_LINE.length).equals(HTTP_LINE);
  if (proto === 17) return f.readUInt16BE(l4) === 1337 && f.readUInt16BE(l4 + 2) === 53 && f.subarray(l4 + 8).includes(DNS_BAIT);
  return false;
}

export interface PcapResult {
  /** The cleaned file. */
  buffer: Buffer;
  /** Records kept. */
  kept: number;
  dropped: number;
  /** Bytes of the dropped records, headers included. */
  droppedBytes: number;
}

interface Span {
  start: number;
  end: number;
  shield: boolean;
}

interface Scan {
  /** Bytes in front of the first span that are always kept (the classic global header). */
  head: number;
  spans: Span[];
  /** Where parsing stopped; a truncated last record or block is left out. */
  stop: number;
}

/** Record spans of a classic pcap, in file order. */
function classicRecords(buf: Buffer, layout: PcapLayout): Scan {
  const spans: Span[] = [];
  let at = 24;
  while (at + 16 <= buf.length) {
    const incl = layout.le ? buf.readUInt32LE(at + 8) : buf.readUInt32BE(at + 8);
    const end = at + 16 + incl;
    if (end > buf.length) break;
    spans.push({ start: at, end, shield: isShieldFrame(buf.subarray(at + 16, end)) });
    at = end;
  }
  return { head: 24, spans, stop: at };
}

function shieldSpans(buf: Buffer): Scan | undefined {
  if (!buf.includes(MARKER)) return undefined;
  const layout = pcapLayout(buf);
  return layout?.linktype === 1 ? classicRecords(buf, layout) : undefined;
}

/** Count of BLA records in the capture; 0 for anything that is not an Ethernet classic pcap. */
export function countShieldRecords(buf: Buffer): number {
  return shieldSpans(buf)?.spans.filter((r) => r.shield).length ?? 0;
}

/** Drop shield frames. `undefined` when there are none. Bytes after a truncated last record are kept. */
export function cleanPcap(buf: Buffer): PcapResult | undefined {
  const s = shieldSpans(buf);
  const bad = s?.spans.filter((r) => r.shield);
  if (!s || !bad?.length) return undefined;
  const keep = [buf.subarray(0, s.head), ...s.spans.filter((r) => !r.shield).map((r) => buf.subarray(r.start, r.end)), buf.subarray(s.stop)];
  return { buffer: Buffer.concat(keep), kept: s.spans.length - bad.length, dropped: bad.length, droppedBytes: bad.reduce((n, r) => n + r.end - r.start, 0) };
}
