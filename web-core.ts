// Core web access functions. Zero dependencies — plain Node with global fetch,
// node:dns and node:net (built-ins only).
// Testable standalone: node --experimental-strip-types test.ts
//
// Design notes:
// - Search: keyless DuckDuckGo HTML endpoint (html.duckduckgo.com/html/).
// - Fetch: HTML -> readable text via a small extractor; JSON/XML/plain returned as-is;
//   binary content is NOT dumped inline (tells the caller to use bash curl -o).
// - SSRF: fetchPage only talks to public internet addresses. IP literals and DNS-resolved
//   targets are checked against private/reserved ranges (incl. cloud metadata
//   169.254.169.254 and IPv4-mapped IPv6). Redirects are followed manually and EVERY hop is
//   re-validated. Intentional local access (e.g. your LLM server) goes through bash curl.

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const MAX_CHARS = 40_000;

class TtlCache<T> {
  private store = new Map<string, { value: T; expires: number }>();
  private ttlMs: number;
  constructor(ttlMs: number) { this.ttlMs = ttlMs; }
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) { this.store.delete(key); return undefined; }
    return entry.value;
  }
  set(key: string, value: T): void {
    if (this.store.size > 200) {
      const now = Date.now();
      for (const [k, v] of this.store) { if (now > v.expires) this.store.delete(k); }
      if (this.store.size > 200) {
        const oldest = this.store.keys().next().value!;
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

const searchCache = new TtlCache<SearchHit[]>(15 * 60_000);
const fetchCache = new TtlCache<{ url: string; status: number; contentType: string; text: string; truncated: boolean; totalChars: number }>(30 * 60_000);

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", amp: "&",
  mdash: "—", ndash: "–", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  sbquo: "‚", bdquo: "„",
  bull: "•", middot: "·", prime: "′", Prime: "″",
  dagger: "†", Dagger: "‡",
  lsaquo: "‹", rsaquo: "›", laquo: "«", raquo: "»",
  iexcl: "¡", iquest: "¿", sect: "§", para: "¶", permil: "‰",
  cent: "¢", pound: "£", yen: "¥", euro: "€", curren: "¤", fnof: "ƒ",
  trade: "™", reg: "®", copy: "©",
  times: "×", divide: "÷", plusmn: "±", minus: "−",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", equiv: "≡",
  infin: "∞", radic: "√", sum: "∑", prod: "∏",
  part: "∂", nabla: "∇", forall: "∀", exists: "∃", empty: "∅",
  isin: "∈", notin: "∉", sub: "⊂", sup: "⊃", sube: "⊆", supe: "⊇",
  cap: "∩", cup: "∪", and: "∧", or: "∨", not: "¬",
  ang: "∠", sdot: "⋅", lowast: "∗",
  lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", lang: "⟨", rang: "⟩",
  oplus: "⊕", otimes: "⊗", perp: "⊥", there4: "∴", sim: "∼", cong: "≅", weierp: "℘",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", crarr: "↵",
  lArr: "⇐", rArr: "⇒", uArr: "⇑", dArr: "⇓", hArr: "⇔",
  frac12: "½", frac14: "¼", frac34: "¾",
  sup1: "¹", sup2: "²", sup3: "³",
  deg: "°", micro: "µ", cedil: "¸",
  ordf: "ª", ordm: "º", macr: "¯", acute: "´", uml: "¨",
  circ: "ˆ", tilde: "˜", shy: "­", brvbar: "¦",
  hearts: "♥", diams: "♦", clubs: "♣", spades: "♠", loz: "◊",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ",
  epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", omicron: "ο", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ",
  Epsilon: "Ε", Zeta: "Ζ", Eta: "Η", Theta: "Θ",
  Iota: "Ι", Kappa: "Κ", Lambda: "Λ", Mu: "Μ",
  Nu: "Ν", Xi: "Ξ", Omicron: "Ο", Pi: "Π",
  Rho: "Ρ", Sigma: "Σ", Tau: "Τ", Upsilon: "Υ",
  Phi: "Φ", Chi: "Χ", Psi: "Ψ", Omega: "Ω",
  sigmaf: "ς", thetasym: "ϑ", upsih: "ϒ", piv: "ϖ",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã",
  auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó",
  ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", thorn: "þ", yuml: "ÿ", szlig: "ß",
  oelig: "œ", OElig: "Œ", AElig: "Æ",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã",
  Auml: "Ä", Aring: "Å", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó",
  Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
  Yacute: "Ý", THORN: "Þ", Scaron: "Š", scaron: "š",
  ensp: " ", emsp: " ", thinsp: " ",
  zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏",
};

/** Decode HTML entities. Single-pass: numeric (&#x...; &#...;) and named (&name;).
 *  Unknown named entities pass through unchanged. Malformed entities never crash. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, inner: string) => {
    if (inner[0] === "#" && (inner[1] === "x" || inner[1] === "X")) return safeFromCode(parseInt(inner.slice(2), 16));
    if (inner[0] === "#") return safeFromCode(parseInt(inner.slice(1), 10));
    return NAMED_ENTITIES[inner] ?? match;
  });
}

const BLOCK_TAGS =
  "p|div|h[1-6]|li|ul|ol|tr|table|thead|tbody|section|article|blockquote|pre|header|footer|nav|main|aside|figure|figcaption|form|fieldset|details|summary|dd|dt|dl";

/** Convert HTML to readable plain text. Not a full parser — good enough for research. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let t = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Closing tags vanish entirely (avoids "bold ." artifacts from </b> -> " ")
  t = t.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, "");
  t = t.replace(/<br\b[^>]*\/?>/gi, "\n");
  t = t.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*\\/??>`, "gi"), "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  t = t.replace(/[ \t\r]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Unwrap DuckDuckGo redirect links to the real target URL. Returns "" if unusable.
 *  Accepts only http(s) absolute URLs and // protocol-relative hrefs (the two forms
 *  DDG emits). Bare relative paths are rejected — with a base URL they would silently
 *  resolve to duckduck.com junk. */
export function resolveDdgUrl(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  let u: URL;
  try {
    u = trimmed.startsWith("//") ? new URL("https:" + trimmed) : new URL(trimmed);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const uddg = u.searchParams.get("uddg");
  if (uddg) return uddg;
  // DDG redirect path without a target — unusable
  if (u.hostname === "duckduckgo.com" && u.pathname.startsWith("/l/")) return "";
  return u.toString();
}

// ============================ SSRF protection ============================

import dns from "node:dns";
import net from "node:net";

/** IPv4 ranges that must never be fetched: [lo, hi] as unsigned 32-bit ints. */
const V4_BLOCKED: Array<[number, number]> = [
  [0x00000000, 0x000000ff], // 0.0.0.0/8 "this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8 private
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 private
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24 IETF
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 private
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 TEST-NET-3 (113 decimal = 0x71!)
  [0xe0000000, 0xffffffff], // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function isBlockedV4Int(n: number): boolean {
  return V4_BLOCKED.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Expand an IPv6 address to 8 x 16-bit words. Handles ::, zone ids, and embedded IPv4 tails.
 *  Returns null if the string is not a valid IPv6 address. */
function v6ToWords(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  let v4tail: number[] | null = null;
  const v4m = /(?:\d{1,3}\.){3}\d{1,3}$/.exec(s);
  if (v4m) {
    const n = v4ToInt(v4m[0]);
    if (n === null) return null;
    v4tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, s.length - v4m[0].length);
    // "::1.1.1.1" -> "::" (keep!); "1:2:3:4:5:6:1.2.3.4" -> "1:2:3:4:5:6:" -> strip;
    // "1::1.2.3.4" -> "1::" (keep — v4 belongs to the tail side)
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const pieces = s.split("::");
  if (pieces.length > 2) return null;
  const parseSide = (side: string, isLast: boolean): number[] | null => {
    if (side === "") return isLast && v4tail ? [...v4tail] : [];
    const groups = side.split(":");
    if (groups.some((g) => g === "" || !/^[0-9a-f]{1,4}$/.test(g))) return null;
    const words = groups.map((g) => parseInt(g, 16));
    if (isLast && v4tail) words.push(...v4tail);
    return words;
  };
  if (pieces.length === 1) {
    const words = parseSide(pieces[0], true);
    return words && words.length === 8 ? words : null;
  }
  const head = parseSide(pieces[0], false);
  const tail = parseSide(pieces[1], true);
  if (!head || !tail || head.length + tail.length >= 8) return null;
  return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

function isBlockedV6Words(w: number[]): boolean {
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  // IPv4-embedded forms (layout 0:0:0:0:0:X:hh:ll, X=ffff mapped / X=0 legacy-compatible).
  // The IPv4 bytes always sit in words 6-7; only the marker word differs.
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0) {
    if (w[5] === 0xffff || w[5] === 0) {
      return isBlockedV4Int((((w[6] & 0xffff) << 16) | (w[7] & 0xffff)) >>> 0);
    }
  }
  return false;
}

/** Check one IP literal. Returns a human reason when blocked, null when public. */
export function isBlockedIp(ip: string): string | null {
  const ver = net.isIP(ip);
  if (ver === 4) {
    const n = v4ToInt(ip);
    if (n === null) return "unparseable IPv4 (blocked fail-safe)";
    return isBlockedV4Int(n) ? "private/reserved IPv4 range" : null;
  }
  if (ver === 6) {
    const words = v6ToWords(ip);
    if (!words) return "unparseable IPv6 (blocked fail-safe)";
    return isBlockedV6Words(words) ? "private/reserved IPv6 range" : null;
  }
  return "not an IP address";
}

function ssrfError(host: string, why: string): Error {
  return new Error(
    `Blocked by SSRF protection: ${host} (${why}). ` +
      `This tool only fetches public internet addresses. If you intentionally need local ` +
      `network access (e.g. a local LLM server), use: bash curl <url>`,
  );
}

const LOOPBACK_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback", "ipc6-loopback"]);

/** Validate that a URL may be fetched: http(s) only, and the host (or any address it
 *  resolves to) is a public internet address. Returns the parsed URL; throws otherwise.
 *  Fail-safe: anything unparseable or unresolvable is blocked. */
export async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${u.protocol} (use bash curl for other schemes)`);
  }
  // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]") — strip for IP checks.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(host.toLowerCase())) {
    throw ssrfError(host, "loopback name");
  }
  if (net.isIP(host)) {
    const why = isBlockedIp(host);
    if (why) throw ssrfError(host, why);
    return u;
  }
  // Domain name: resolve ALL records and block if ANY resolves privately (fail-safe —
  // fetch could connect to any of them).
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`Blocked (DNS lookup failed for ${host}, cannot verify it is public): ${(e as Error).message}`);
  }
  if (addrs.length === 0) throw ssrfError(host, "resolved no addresses");
  for (const a of addrs) {
    const why = isBlockedIp(a.address);
    if (why) throw ssrfError(host, `resolves to ${a.address} — ${why}`);
  }
  return u;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Keyless web search via DuckDuckGo's HTML endpoint. */
export async function searchDuckDuckGo(
  query: string,
  numResults = 8,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const wait = DDG_MIN_INTERVAL_MS - (Date.now() - ddgLastCallMs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  ddgLastCallMs = Date.now();
  const endpoint = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const res = await fetch(endpoint, {
    headers: { "user-agent": USER_AGENT },
    signal,
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  const html = await res.text();

  const hitBlocks = html.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  if (hitBlocks.length === 0) {
    throw new Error(
      "DuckDuckGo returned no parseable results (possible anomaly/rate-limit page — retry shortly)",
    );
  }
  const snippets = (html.match(/<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/g) ?? []).map(
    (b) => decodeEntities(b.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
  );

  const n = Math.max(1, Math.min(numResults, 20));
  return hitBlocks
    .slice(0, n)
    .map((block, i) => {
      const href = /href="([^"]+)"/.exec(block)?.[1] ?? "";
      return {
        title: decodeEntities(block.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
        url: resolveDdgUrl(href),
        snippet: snippets[i] ?? "",
      };
    })
    .filter((h) => h.url && h.title);
}

export interface FetchedPage {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  totalChars: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Fetch a URL. HTML is converted to text; JSON/XML/plain returned raw; binary refused inline.
 *  SSRF-safe: the initial URL and every redirect hop are validated by validatePublicUrl. */
export async function fetchPage(
  rawUrl: string,
  opts: { maxChars?: number; signal?: AbortSignal } = {},
): Promise<FetchedPage> {
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const cached = fetchCache.get(rawUrl);
  if (cached) return cached;
  let currentUrl = await validatePublicUrl(rawUrl);

  let res: Response;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) for ${rawUrl}`);
    }
    res = await fetch(currentUrl, {
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en",
      },
      signal: opts.signal,
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (location && REDIRECT_STATUSES.has(res.status)) {
      await res.body?.cancel();
      // Re-validate the redirect target — a public page must not be able to
      // bounce us to a private/internal address.
      currentUrl = await validatePublicUrl(new URL(location, currentUrl).toString());
      continue;
    }
    break;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${currentUrl.toString()}`);

  const kind = contentType.toLowerCase();
  let text: string;
  if (kind.includes("html") || kind.includes("xhtml")) {
    text = htmlToText(raw);
  } else if (
    kind.includes("json") ||
    kind.includes("xml") ||
    kind.includes("javascript") ||
    kind.includes("text/") ||
    kind === ""
  ) {
    text = raw;
  } else {
    text = `[binary content: ${contentType || "unknown type"}, not useful inline. Save it with: bash curl -sL -o <file> ${currentUrl.toString()}]`;
  }

  const totalChars = text.length;
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const result: FetchedPage = {
    url: res.url || currentUrl.toString(),
    status: res.status,
    contentType,
    text,
    truncated: totalChars > maxChars,
    totalChars,
  };
  fetchCache.set(rawUrl, result);
  return result;
}

// ====================== Search providers & fallbacks ======================
//
// Chain: Brave API (PI_BRAVE_API_KEY, when set) -> DuckDuckGo (keyless) ->
// SearXNG (PI_SEARXNG_URL, comma-separated instance URLs).
//
// Contract verified 2026-07-09 against primary sources:
// - Brave: api.search.brave.com/res/v1/web/search?q=... with X-Subscription-Token
//   header. Returns {web: {results: [{title, url, description, ...}]}}.
// - SearXNG: searx/webapp.py + searx/webutils.py (master). GET /search?format=json
//   -> {query, results: [{title, url, content, ...}]}; HTTP 403 when the instance's
//   settings.search.formats lacks "json"; errors come back as {"error": "..."}.
//
// NOTE: fallback endpoints come from user config (env), NOT from model input, so the
// SSRF guard does not apply here — the model cannot influence which instance is used.

const PROVIDER_TIMEOUT_MS = 8_000;
const DDG_MIN_INTERVAL_MS = 3_000;
let ddgLastCallMs = 0;

/** Combine the caller's abort signal with a per-attempt timeout (never wait unbounded). */
function attemptSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const parts: AbortSignal[] = [AbortSignal.timeout(ms)];
  if (signal) parts.push(signal);
  return AbortSignal.any(parts);
}

/** Parse a Brave Web Search API response into hits. */
export function parseBraveResults(json: unknown): SearchHit[] {
  if (typeof json !== "object" || json === null) {
    throw new Error("Brave: response is not a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const web = obj.web as Record<string, unknown> | undefined;
  if (!web || !Array.isArray(web.results)) {
    throw new Error("Brave: response has no web.results[]");
  }
  return web.results
    .map((r): SearchHit => {
      const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
      return {
        title: typeof o.title === "string" ? o.title.trim() : "",
        url: typeof o.url === "string" ? o.url : "",
        snippet: typeof o.description === "string" ? o.description.replace(/\s+/g, " ").trim() : "",
      };
    })
    .filter((h) => h.title && h.url);
}

/** Query the Brave Web Search API. Requires PI_BRAVE_API_KEY. */
export async function searchBrave(
  query: string,
  numResults: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 20)}`;
  const res = await fetch(url, {
    headers: {
      "X-Subscription-Token": apiKey,
      accept: "application/json",
    },
    signal: attemptSignal(signal, PROVIDER_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Brave API: HTTP ${res.status} — invalid or expired API key`);
  }
  if (res.status === 429) {
    throw new Error("Brave API: HTTP 429 — rate limited");
  }
  if (!res.ok) throw new Error(`Brave API: HTTP ${res.status}`);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Brave API: non-JSON response");
  }
  return parseBraveResults(json).slice(0, Math.max(1, Math.min(numResults, 20)));
}

/** Parse a SearXNG JSON response into hits. Throws on malformed/error responses. */
export function parseSearxngResults(json: unknown): SearchHit[] {
  if (typeof json !== "object" || json === null) {
    throw new Error("SearXNG: response is not a JSON object");
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.error === "string") throw new Error(`SearXNG error: ${obj.error}`);
  if (!Array.isArray(obj.results)) throw new Error("SearXNG: response has no results[]");
  return obj.results
    .map((r): SearchHit => {
      const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
      return {
        title: typeof o.title === "string" ? o.title.trim() : "",
        url: typeof o.url === "string" ? o.url : "",
        snippet: typeof o.content === "string" ? o.content.replace(/\s+/g, " ").trim() : "",
      };
    })
    .filter((h) => h.title && h.url);
}

/** Query a SearXNG instance's JSON API. */
export async function searchSearxng(
  query: string,
  numResults: number,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: attemptSignal(signal, PROVIDER_TIMEOUT_MS),
  });
  if (res.status === 403) {
    throw new Error(
      `SearXNG ${base}: HTTP 403 — instance has the JSON format disabled (settings: search.formats must include "json")`,
    );
  }
  if (!res.ok) throw new Error(`SearXNG ${base}: HTTP ${res.status}`);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`SearXNG ${base}: non-JSON response (bot wall or proxy?)`);
  }
  return parseSearxngResults(json).slice(0, Math.max(1, Math.min(numResults, 20)));
}

export interface SearchProviderSpec {
  name: string;
  search: (query: string, numResults: number, signal?: AbortSignal) => Promise<SearchHit[]>;
}

export interface WebSearchResult {
  provider: string;
  hits: SearchHit[];
}

/** Brave API key from PI_BRAVE_API_KEY. */
export function braveApiKeyFromEnv(): string {
  return (process.env.PI_BRAVE_API_KEY ?? "").trim();
}

/** SearXNG instance URLs from PI_SEARXNG_URL (comma-separated). */
export function searxngInstancesFromEnv(): string[] {
  return (process.env.PI_SEARXNG_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Search with a fallback chain. First successful provider wins; every attempt has a
 *  timeout; a user abort (Esc) is rethrown immediately without falling back. */
export async function searchWeb(
  query: string,
  numResults = 8,
  signal?: AbortSignal,
  providers?: SearchProviderSpec[],
): Promise<WebSearchResult> {
  const braveKey = braveApiKeyFromEnv();
  const chain: SearchProviderSpec[] =
    providers ??
    [
      { name: "duckduckgo", search: (q, n, s) => searchDuckDuckGo(q, n, attemptSignal(s, PROVIDER_TIMEOUT_MS)) },
      ...(braveKey ? [{ name: "brave", search: (q: string, n: number, s?: AbortSignal) => searchBrave(q, n, braveKey, s) }] : []),
      ...searxngInstancesFromEnv().map((u) => ({
        name: `searxng:${safeHostname(u)}`,
        search: (q: string, n: number, s?: AbortSignal) => searchSearxng(q, n, u, s),
      })),
    ];

  const failures: string[] = [];
  for (const p of chain) {
    try {
      const cacheKey = `${p.name}:${query}:${numResults}`;
      const cached = searchCache.get(cacheKey);
      if (cached) return { provider: `${p.name}(cached)`, hits: cached };
      const hits = await p.search(query, numResults, signal);
      searchCache.set(cacheKey, hits);
      return { provider: p.name, hits };
    } catch (e) {
      if (signal?.aborted) throw e;
      failures.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`web search failed on all providers:\n  ${failures.join("\n  ")}`);
}

function safeHostname(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

// ====================== PDF text extraction ======================

/**
 * Extract text from a PDF file using poppler's pdftotext.
 * Requires `pdftotext` on PATH (brew install poppler).
 */
export function readPdf(filePath: string, options?: { pages?: string }): string {
  const { execSync } = require("node:child_process");
  const { existsSync } = require("node:fs");
  const { resolve } = require("node:path");

  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`PDF file not found: ${resolved}`);
  }

  const args = ["pdftotext"];
  if (options?.pages) {
    const match = options.pages.match(/^(\d+)(?:-(\d+))?$/);
    if (match) {
      args.push("-f", match[1]);
      if (match[2]) args.push("-l", match[2]);
    }
  }
  args.push("-layout", resolved, "-");

  try {
    const result = execSync(args.join(" "), {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return result.toString("utf-8").trim();
  } catch (e: any) {
    if (e.status !== undefined) {
      throw new Error(`pdftotext failed (exit ${e.status}): ${e.stderr?.toString() || "unknown error"}`);
    }
    throw e;
  }
}
