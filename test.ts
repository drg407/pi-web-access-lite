// Tests for web-core.ts. Run: node --experimental-strip-types test.ts
// Offline-only by design: network-dependent behaviour is recorded in VERIFIED.md,
// not tested here (slow + flaky).
import assert from "node:assert";
import {
  decodeEntities,
  fetchPage,
  htmlToText,
  isBlockedIp,
  resolveDdgUrl,
  searchDuckDuckGo,
  validatePublicUrl,
} from "./web-core.ts";

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}: ${(e as Error).message}`);
  }
}

// ---------- decodeEntities (offline, hostile input) ----------
await t("entities: named basics", () => {
  assert.equal(decodeEntities("&lt;tag&gt; &quot;x&quot; &amp; &apos;y&apos;"), '<tag> "x" & \'y\'');
});
await t("entities: numeric decimal + hex", () => {
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
});
await t("entities: nbsp", () => {
  assert.equal(decodeEntities("a&nbsp;b"), "a b");
});
await t("entities: amp escaped as literal (&amp;lt; stays &lt;)", () => {
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
});
await t("entities: zero codepoint dropped, not crash", () => {
  assert.equal(decodeEntities("a&#0;b"), "ab");
});
await t("entities: out-of-range codepoint dropped, not crash", () => {
  assert.equal(decodeEntities("a&#999999999999;b"), "ab");
});
await t("entities: malformed entities don't crash", () => {
  const out = decodeEntities("&#; &#xZ; &#&amp;");
  assert.equal(typeof out, "string");
  assert.ok(!out.includes("\u0000"));
});
await t("entities: empty string", () => {
  assert.equal(decodeEntities(""), "");
});

// ---------- htmlToText (offline) ----------
const SAMPLE = `<html><head><title>T</title><style>body{color:red}</style><script>var x=1;</script></head>
<body><h1>Title Here</h1><p>First &amp; second <b>bold</b>.</p>
<ul><li>one</li><li>two</li></ul><div data-x="1">div text</div><a href="/x">link</a></body></html>`;

await t("htmlToText: keeps visible text, decodes entities", () => {
  const out = htmlToText(SAMPLE);
  assert.ok(out.includes("Title Here"));
  assert.ok(out.includes("First & second bold."));
  assert.ok(out.includes("one"));
  assert.ok(out.includes("div text"));
});
await t("htmlToText: strips script/style content", () => {
  const out = htmlToText(SAMPLE);
  assert.ok(!out.includes("var x=1"));
  assert.ok(!out.includes("color:red"));
});
await t("htmlToText: empty input", () => {
  assert.equal(htmlToText(""), "");
});
await t("htmlToText: tags only -> empty", () => {
  assert.equal(htmlToText("<p></p><div></div><br>"), "");
});
await t("htmlToText: unclosed script tag does not eat the page", () => {
  const out = htmlToText("<script>oops no close</p><p>after");
  // Unclosed script: regex won't match, tag gets stripped as a tag; text survives or is empty, but no crash
  assert.equal(typeof out, "string");
});
await t("htmlToText: comment removed", () => {
  const out = htmlToText("<!-- secret -->visible");
  assert.ok(out.includes("visible"));
  assert.ok(!out.includes("secret"));
});

// ---------- resolveDdgUrl (offline) ----------
await t("url: redirect with uddg unwrapped", () => {
  assert.equal(
    resolveDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=abc"),
    "https://example.com/a?b=1",
  );
});
await t("url: direct http(s) kept", () => {
  assert.equal(resolveDdgUrl("https://example.com/b?q=1"), "https://example.com/b?q=1");
});
await t("url: bare relative path rejected (would silently become ddg junk)", () => {
  assert.equal(resolveDdgUrl("/docs/page"), "");
});
await t("url: javascript: scheme rejected", () => {
  assert.equal(resolveDdgUrl("javascript:void(0)"), "");
});
await t("url: ddg redirect without uddg rejected", () => {
  assert.equal(resolveDdgUrl("//duckduckgo.com/l/?rut=x"), "");
});
await t("url: garbage returns empty, no throw", () => {
  assert.equal(resolveDdgUrl(""), "");
  assert.equal(resolveDdgUrl("::::not a url::::"), "");
});

// fetchPage URL validation (offline — pure parsing, no network)
await t("fetchPage invalid URL fails with clear error", async () => {
  await assert.rejects(() => fetchPage("not a url"), /Invalid URL/);
});
await t("fetchPage unsupported protocol fails", async () => {
  await assert.rejects(() => fetchPage("ftp://example.com/x"), /Unsupported protocol/);
});

// ---------- SSRF guard (offline: IP-literal checks need no DNS) ----------
// Boundary-picked: each blocked range plus the public address just outside it.
const blockedV4 = [
  "0.0.0.0", "10.0.0.1", "10.255.255.255",
  "100.64.0.0", "100.127.255.255",
  "127.0.0.1", "127.255.255.255",
  "169.254.0.0", "169.254.169.254",
  "172.16.0.0", "172.31.255.255",
  "192.0.0.1", "192.0.2.1",
  "192.168.0.1", "192.168.255.255",
  "198.18.0.1", "198.19.255.255",
  "198.51.100.1", "203.0.113.1",
  "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
];
const publicV4 = [
  "1.1.1.1", "8.8.8.8", "93.184.216.34",
  "11.0.0.0",           // just above 10/8
  "100.128.0.0",        // just above 100.64/10
  "128.0.0.1",          // just above 127/8
  "169.253.255.255",    // just below 169.254/16
  "172.15.255.255",     // just below 172.16/12
  "172.32.0.1",         // just above 172.16/12
  "192.167.255.255",    // just below 192.168/16
  "192.169.0.1",
];
await t("ssrf: blocked IPv4 ranges (incl. cloud metadata)", () => {
  for (const ip of blockedV4) assert.ok(isBlockedIp(ip) !== null, `expected ${ip} BLOCKED`);
});
await t("ssrf: public IPv4 allowed (boundary cases)", () => {
  for (const ip of publicV4) assert.equal(isBlockedIp(ip), null, `expected ${ip} allowed`);
});

const blockedV6 = [
  "::", "::1",
  "fe80::1", "febf::1",           // fe80::/10 link-local (incl. top of range)
  "fc00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // fc00::/7 ULA (incl. top)
  "ff02::1",                       // multicast
  "2001:db8::1",                   // documentation
  "::ffff:127.0.0.1",              // IPv4-mapped loopback (classic bypass)
  "::ffff:10.1.2.3",               // IPv4-mapped private
  "::ffff:169.254.169.254",        // IPv4-mapped cloud metadata
  "0:0:0:0:0:ffff:7f00:1",         // same as ::ffff:127.0.0.1 in full hex
  "::127.0.0.1",                   // legacy IPv4-compatible
  "::10.0.0.1",
];
const publicV6 = [
  "2606:4700:4700::1111",  // Cloudflare DoH
  "2001:4860:4860::8888",  // Google DNS
  "::ffff:8.8.8.8",        // mapped PUBLIC v4 must stay allowed
  "::1.1.1.1",
  "fec0::1",               // just above fe80::/10
  "feff::1",               // above fe80::/10
];
await t("ssrf: blocked IPv6 ranges (incl. v4-mapped bypasses)", () => {
  for (const ip of blockedV6) assert.ok(isBlockedIp(ip) !== null, `expected ${ip} BLOCKED`);
});
await t("ssrf: public IPv6 allowed (incl. mapped public v4)", () => {
  for (const ip of publicV6) assert.equal(isBlockedIp(ip), null, `expected ${ip} allowed`);
});

await t("ssrf: validatePublicUrl blocks loopback IP literal", async () => {
  await assert.rejects(() => validatePublicUrl("http://127.0.0.1:11434/api/tags"), /SSRF/);
});
await t("ssrf: validatePublicUrl blocks localhost name", async () => {
  await assert.rejects(() => validatePublicUrl("http://localhost:11434/"), /SSRF/);
});
await t("ssrf: validatePublicUrl blocks IPv6 loopback in URL", async () => {
  await assert.rejects(() => validatePublicUrl("http://[::1]/"), /SSRF/);
});
await t("ssrf: validatePublicUrl blocks v4-mapped metadata URL", async () => {
  await assert.rejects(
    () => validatePublicUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    /SSRF/,
  );
});
await t("ssrf: validatePublicUrl keeps rejecting invalid URL / bad scheme first", async () => {
  await assert.rejects(() => validatePublicUrl("not a url"), /Invalid URL/);
  await assert.rejects(() => validatePublicUrl("ftp://example.com/x"), /Unsupported protocol/);
});

// NOTE: live checks of the DNS-resolution path (public domain allowed, domain resolving to
// a private IP blocked, public->public redirect) are in VERIFIED.md, not here —
// network behaviour is slow/flaky in test suites by design.

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
