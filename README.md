# pi-web-access-lite

## About

Two small web tools for the [pi](https://pi.dev) coding agent: **`web_search`** (keyless
DuckDuckGo with automatic SearXNG / Brave fallback) and **`fetch_page`** (SSRF-safe page
fetching). Zero npm dependencies, zero API keys required — plain Node built-ins only.

Built because the popular [`pi-web-access`](https://pi.dev/packages/pi-web-access) package is
8.4 MB / 150 files / 20+ search providers / video + PDF understanding — and for everyday
research you mostly just need *search* and *fetch*, without the supply chain.

The whole network behaviour of this extension fits in two source files (~300 lines each).
There is no `node_modules`, no lockfile, and no third-party code anywhere in the chain —
the audit is the code.

**Current state (2026-09-02):** 49/49 offline tests passing; live-verified end-to-end
through pi's loader, including the fallback chain answering for a rate-limited DuckDuckGo
against a self-hosted SearXNG instance. See `VERIFIED.md` for commands, outputs, and dates.

## The benefit

| | pi-web-access (npm) | pi-web-access-lite (this) |
|---|---|---|
| Size | 8.4 MB, 150 files, 9 deps | ~300 lines, 2 source files, **0 deps** |
| npm supply chain | 9 runtime deps to audit | nothing to audit — no `node_modules`, no lockfile |
| API keys | optional (20+ providers) | none (DuckDuckGo HTML endpoint) |
| Search | 20+ providers w/ fallbacks | DuckDuckGo (keyless) + optional SearXNG / Brave fallbacks |
| Fetch | markdown extract, PDF, video, GitHub/YouTube special-casing | HTML→text, JSON/raw, 40K truncation |
| SSRF protection | yes (remote fetchers opt-in) | **always on**: private/loopback/link-local/metadata blocked, every redirect hop re-validated |
| Audit effort | read a package | read 2 files |

The pitch: **the entire network behaviour of this tool fits in two files you can read in ten
minutes**, and there is no third-party code anywhere in the chain.

## Tools

### `web_search`
Keyless DuckDuckGo search. Returns numbered title / URL / snippet lists.

```ts
web_search({ query: "godot 4 RayCast3D" })
web_search({ query: "rust async", num_results: 10 })   // default 8, cap 20
```

### Search providers & fallback (automatic)

`web_search` tries providers in order and uses the first that succeeds; the output names the
provider that answered. Every attempt has an 8s timeout; an Esc abort is respected (no
fallback attempts after cancellation).

| Order | Provider | Config | Notes |
|---|---|---|---|
| 1 | DuckDuckGo | none (keyless) | default |
| 2..n | SearXNG instances | `PI_SEARXNG_URL="http://host1:8080,http://host2:8080"` | **self-hosted recommended** — queries never leave your machine. The instance must enable the JSON format (see example below — the official image does NOT) |
| last | Brave Search | `PI_BRAVE_API_KEY="BSA..."` | free tier available; Brave does not track queries; independent index |

Example — fully private search fallback via a local SearXNG (docker **or** podman, both
verified):

The official image's default config has the JSON format **disabled** (the API answers 403),
so mount a small settings file that enables it:

```bash
# 1. settings.yml (a one-off secret is enough for a local instance):
#    use_default_settings: true
#    server:
#      secret_key: "<64 hex chars, e.g. openssl rand -hex 32>"
#      limiter: false        # enable + Valkey sidecar if you expose beyond a trusted LAN
#    search:
#      formats: [html, json]

# 2. run it (podman works identically):
podman run -d --name searxng -p 8888:8080 \
   -v $PWD/settings.yml:/etc/searxng/settings.yml:ro docker.io/searxng/searxng

# 3. point pi at it (shell profile or pi's env):
export PI_SEARXNG_URL="http://127.0.0.1:8888"
```

Public SearXNG instances were surveyed on 2026-07-09 and **all tested ones were bot-walled
or rate-limited** for non-browser clients — self-hosting is the reliable option. Details in
`VERIFIED.md`.

> The fallback endpoints come from your environment, not from the agent, so the model cannot
> influence which instance is contacted (no SSRF surface here).

### `fetch_page`
Fetch an http(s) URL as readable text. HTML is converted to plain text; JSON/XML/plain text
comes back as-is; binary content is refused inline (the tool tells you to `bash curl -sL -o`
instead). Truncated at 40,000 chars with a notice.

```ts
fetch_page({ url: "https://docs.godotengine.org/en/stable/classes/class_raycast3d.html" })
fetch_page({ url: "https://api.github.com/repos/godotengine/godot" })  // JSON returned raw
```

For binaries, downloads, raw HTML, non-http(s) schemes, or intentional local-network access
(e.g. your local LLM server at `127.0.0.1:11434`), the tool deliberately refuses and points
you at `bash curl`.

## Security

- **SSRF guard (always on).** IP literals and DNS-resolved targets are checked against all
  private/reserved ranges: loopback, RFC1918, CGNAT, link-local (incl. cloud metadata
  `169.254.169.254`), multicast, reserved, test-nets — including IPv4-mapped IPv6 forms
  (`::ffff:127.0.0.1`) and legacy-compatible forms. Domain names resolve with `all: true` and
  **every** returned address is checked, so public names resolving to private IPs
  (`127.0.0.1.nip.io`, `localtest.me`, …) are blocked. DNS failure = blocked (fail-safe).
- **Redirects are followed manually (max 5) and every hop is re-validated**, so a public page
  cannot bounce a fetch to an internal address.
- http(s) only. Everything else is rejected.
- Known residual risk (documented, accepted): DNS rebinding in the window between validation
  and connect is not pinned — closing that requires an undici dispatcher dependency, which
  this package deliberately avoids. See `VERIFIED.md`.

## Install

Requires pi (tested with pi 0.84.x).

**Option A — install as a pi package (recommended):**

```bash
pi install git:github.com/drg407/pi-web-access-lite
# or
pi install https://github.com/drg407/pi-web-access-lite
```

**Option B — copy the two source files** into pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/web-access
cp index.ts web-core.ts ~/.pi/agent/extensions/web-access/
```

Then run `/reload` in pi (or start a new session). The `web_search` and `fetch_page` tools
appear in the tool list.

**Uninstall:**

```bash
pi remove git:github.com/drg407/pi-web-access-lite   # for option A
rm -rf ~/.pi/agent/extensions/web-access             # for option B
```

> **Note:** if you install via option A while a manual copy from option B still exists, you'll
> have duplicate registrations — remove the manual copy.

## Development

No build step, no dependencies. The core (`web-core.ts`) runs under plain Node with type
stripping (Node 22.6+):

```bash
node --experimental-strip-types test.ts
```

- `web-core.ts` — zero-dependency core: search, fetch, SSRF validation, HTML→text, entities.
- `index.ts` — `pi.registerTool()` wiring for the two tools.
- `test.ts` — 49 offline tests (network behaviour is recorded in `VERIFIED.md`, not tested).
- `VERIFIED.md` — live network verifications with commands, real outputs, and dates. Re-run
  when you suspect the DuckDuckGo markup contract changed.

## Limitations (by design)

- No PDF/video/GitHub-special-casing — that's what the bigger package is for.
- DuckDuckGo's HTML endpoint rate-limits aggressive use (~10 fast requests); normal research
  cadence is fine. With a SearXNG/Brave fallback configured, the chain absorbs those
  incidents automatically; without one, the tool throws a clear error rather than returning
  garbage.
- SearXNG fallback requires a reachable instance (self-hosted recommended — public instances
  are bot-walled, see above). Brave requires a (free-tier) API key.
- Output truncated at 40K chars (context-window protection, not a bug).

## License

MIT — see [LICENSE](./LICENSE).
