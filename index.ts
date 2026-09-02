// pi-web-access-lite: two tools — web_search (keyless DuckDuckGo) and fetch_page (URL -> text).
// Core logic lives in web-core.ts (zero deps, unit-tested separately in test.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  fetchPage,
  searchDuckDuckGo,
  type FetchedPage,
  type SearchHit,
} from "./web-core.ts";

function hitsToText(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `Search: "${query}"\n\n(no results)`;
  return (
    `Search: "${query}"\n\n` +
    hits
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`)
      .join("\n\n")
  );
}

function pageToText(page: FetchedPage): string {
  const trunc = page.truncated
    ? `\n[truncated: showing ${page.text.length} of ${page.totalChars} chars — refetch with a narrower URL or use bash curl for the raw page]`
    : "";
  return `URL: ${page.url}\nStatus: ${page.status}  Content-Type: ${page.contentType || "(none)"}${trunc}\n\n${page.text}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via keyless DuckDuckGo. Returns titles, URLs, snippets. Use fetch_page to read a result in full.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      num_results: Type.Optional(
        Type.Number({ description: "Max results (default 8, cap 20)" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const hits = await searchDuckDuckGo(params.query, params.num_results ?? 8, signal);
      return {
        content: [{ type: "text" as const, text: hitsToText(hits, params.query) }],
        details: { count: hits.length },
      };
    },
  });

  pi.registerTool({
    name: "fetch_page",
    label: "Fetch Page",
    description:
      "Fetch an http(s) URL and return readable text (HTML converted to plain text; JSON/XML/plain returned as-is). Truncated to ~40K chars. For binaries, downloads, raw HTML, or non-http schemes, use bash curl instead.",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal) {
      const page = await fetchPage(params.url, { signal });
      return {
        content: [{ type: "text" as const, text: pageToText(page) }],
        details: { truncated: page.truncated, totalChars: page.totalChars },
      };
    },
  });
}
