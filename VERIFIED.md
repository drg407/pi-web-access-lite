# VERIFIED

Environment-dependent behaviour (network) is recorded here per working rules, not tested in
`test.ts` (network tests are slow/flaky and got deleted everywhere else). Re-run the commands
when you suspect the external contracts changed (DDG markup, endpoints).

## 2026-07-09

### DuckDuckGo keyless search endpoint

Command:
```bash
curl -s --max-time 10 -A "Mozilla/5.0" "https://html.duckduckgo.com/html/?q=godot+4+RayCast3D" \
  | grep -o 'result__a[^>]*href="[^"]*"[^>]*>[^<]*' | head -3
```

Observed: 200 OK; results use `<a class="result__a" href="//duckduckgo.com/l/?uddg=<urlencoded>&rut=...">TITLE</a>`
and `<a class="result__snippet" ...>SNIPPET</a>` markup (confirmed present). Top hit was
`https://docs.godotengine.org/en/4.4/classes/class_raycast3d.html`.

Caveat observed: hammering the endpoint (~10 requests in a few minutes) returns an anomaly page
with no `result__a` blocks. `searchDuckDuckGo` then throws a clear "no parseable results" error.
Normal research cadence (a handful of searches) did not trigger it.

### fetch_page live behaviour (via jiti smoke run of the real extension, 2026-07-09)

- `https://example.com` → 200, `text/html`, extracted "Example Domain" (143 chars, not truncated)
- `https://www.github.com` → 301 followed to `https://github.com/`, final URL reported
- `https://api.github.com/repos/godotengine/godot` → JSON returned raw and parseable
- HTTP 404 → throws `HTTP 404 for <url>` (verified in live run)
- `http://example.com` serves 200 directly (no redirect) — verified with curl -w

### End-to-end through pi's own loader (2026-07-09)

Loaded `index.ts` with pi's jiti + its typebox aliases, registered both tools against a stub
`ExtensionAPI`, and executed them for real. Output:

```
registered tools: web_search, fetch_page
web_search("godot 4 raycast", 3) -> 3 hits incl. docs.godotengine.org ray-casting tutorial
fetch_page("https://example.com") -> "Example Domain ..." 143 chars
```

## SSRF guard — live verification, 2026-07-09

Commands (run from `~/.pi/agent/extensions/web-access/`):
```bash
node --experimental-strip-types test.ts          # 31 tests, all offline (IP-literal paths need no DNS)
```

Live DNS-path checks (not in the suite by design):

| Case | Command / tool call | Observed result |
|---|---|---|
| Public domain allowed | `validatePublicUrl("http://example.com/")` | ALLOWED, hostname `example.com` |
| Public name → private IP (loopback) | `validatePublicUrl("http://127.0.0.1.nip.io/")` | BLOCKED: `resolves to 127.0.0.1 — private/reserved IPv4 range` |
| Public name → metadata IP | `validatePublicUrl("http://169.254.169.254.nip.io/")` | BLOCKED: `resolves to 169.254.169.254 — private/reserved` |
| Public→public redirect | `fetchPage("https://www.github.com")` | 200, final host `github.com` (per-hop validation did not break normal redirects) |
| Loopback via the registered tool (pi jiti loader) | `fetch_page({url: "http://127.0.0.1:11434/"})` | `Blocked by SSRF protection: 127.0.0.1 (private/reserved IPv4 range). …use: bash curl` |

RED check: neutering the v4 range check (`isBlockedV4Int` → always false) made 4 tests fail,
incl. both IPv4-mapped-IPv6 bypass tests. 27 passed, 4 failed.

Bugs the SSRF test battery caught (all fixed, see git-less history in this session):
- 169.254/16 range upper bound was /24-wide (metadata IP escaped)
- 203.0.113.0/24 constant written as 0x0d (13) instead of 0x71 (113) — blocked the wrong
  public range, let TEST-NET-3 through
- IPv4-embedded-in-IPv6 word indices off by one (marker is word 5, v4 bytes words 6-7)
- WHATWG URL keeps brackets on IPv6 hostnames (`"[::1]"`) — IP check never ran
- v6 tail-strip mangled `"::"` (from `::1.1.1.1`) and empty-side parse dropped the v4 tail

Known residual risk (accepted): DNS rebinding between validation and connect is not pinned
(would need undici dispatcher / socket-level lookup = an npm dependency, deliberately avoided).

## Search fallbacks — contract verification & provider survey, 2026-07-09

### API contracts (verified against primary sources, not guessed)

**SearXNG JSON API** — from source, `searxng/searxng@master`:
- `searx/webapp.py`: `GET /search` accepts `format` in `{html, json, csv, rss}`; returns
  **HTTP 403** when the instance's `settings['search']['formats']` lacks `json`; errors come
  back as `{"error": "..."}` with 400/500.
- `searx/webutils.py::get_json_response`: body is
  `{query, results: [result dicts], answers, corrections, infoboxes, suggestions, unresponsive_engines}`;
  result dicts carry `title`, `url`, `content`.

**Brave Web Search API** — from official docs (api-dashboard.search.brave.com):
- `GET https://api.search.brave.com/res/v1/web/search?q=...&count=N` (count max 20), header
  `X-Subscription-Token: <key>`, body `{web: {results: [{title, url, description, ...}]}}`.

Live calls to Brave/SearXNG were NOT executed (no key / no reachable instance available at
build time); HTTP+parse layers are covered by in-process loopback mock-server tests in
`test.ts`, and parsers by fixture tests.

### Public SearXNG instance survey (why self-hosting is the recommendation)

Source: searx.space registry (`https://searx.space/data/instances.json`, 92 instances,
20 with healthy search metrics on 2026-07-09). JSON API probed on the 12 top-ranked
instances with a browser user-agent:

| Instance | Result |
|---|---|
| searx.be | Anubis browser-verification wall |
| search.bus-hit.me, search.ononoki.org, nordsearch.de, searxng.ch, searxng.deggo.fyi, searx.oloke.xyz, search.lumy.live | timeout / empty response |
| opnxng.com, priv.au, paulgo.io, searx.tiekoetter.com, search.rhscz.eu, search.inetol.net, search.catboy.house | HTTP 429 |
| searxng.site, searxng.website | Apache 403 |
| search.disroot.org, baresearch.org, searxng.shreven.org, searx.sev.monster | Anubis / bot-check wall |
| searx.linxx.net | "Forbidden: browser verification required" |

**0 of 12 usable** from a plain HTTP client. Also probed: Mojeek (Altcha JS challenge),
Mullvad search (connection refused), Marginalia (help page / tiny index).
Conclusion: public instances gate the JSON API against non-browser traffic; a self-hosted
instance (`docker run -d -p 8888:8080 searxng/searxng`) is the reliable, private fallback.

## Error-handling contract (from pi docs, extensions.md "Error Handling")

"Tool `execute` errors must be signaled by throwing; the thrown error is caught, reported to the
LLM with `isError: true`, and execution continues." — this extension's throws rely on that.
