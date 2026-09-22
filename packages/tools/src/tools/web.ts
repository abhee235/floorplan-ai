// The web, as two tools, for what a skill cannot hold (ADR-027 D1, D4).
//
// Search and page reading were built for the product verifier (ADR-008) and never offered to the
// designer. They are offered now, behind `ctx.web`, which the host fills only when a search provider
// is configured: a session without one never sees these tools and pays nothing for them. What a
// page says lives in a tool result, which compaction is designed to drop, so both descriptions say
// to write the useful part into notes.
import { htmlToText } from "@fpv/catalog";
import { z } from "zod";
import { ToolError, unavailable } from "../envelope.js";
import { defineTool, TIMEOUTS } from "../registry.js";

const DEFAULT_PAGE_CHARS = 8_000;

const NO_WEB = "this session has no search provider";
const HOW =
  "the host needs FPV_SEARCH=searxng and FPV_SEARCH_URL, or FPV_SEARCH=brave and a key; work from what you know and say so";

export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web. kind 'web' returns pages as title, url and snippet; kind 'images' returns pictures you can then look_at by url. Use it for what no skill covers: a named style, brand or building type you have no skill for, a real building to model on, a product the catalog lacks. Not for what you already know, and not on every run: a search is a step spent not drawing. Put what you learn into notes.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  input: z.object({
    query: z.string().min(1).describe("a few words, e.g. 'open plan office neighbourhood layout'"),
    kind: z.enum(["web", "images"]).optional().describe("default web"),
    limit: z.number().int().min(1).max(10).optional().describe("default 5"),
  }),
  output: z.object({
    kind: z.enum(["web", "images"]),
    hits: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string().optional(),
        /** For a picture: the page it was found on. */
        source: z.string().optional(),
        thumbnail: z.string().nullable().optional(),
      }),
    ),
  }),
  async run(args, call) {
    const web = call.ctx.web;
    if (!web) throw unavailable("web_search", NO_WEB, HOW);
    const limit = args.limit ?? 5;
    const kind = args.kind ?? "web";
    try {
      if (kind === "images") {
        if (!web.search.images)
          throw unavailable(
            "web_search",
            `${web.search.id} has no image search`,
            "search kind web and read_page instead",
          );
        const hits = await web.search.images(args.query, { limit });
        return {
          kind,
          hits: hits.map((h) => ({ title: h.title, url: h.url, source: h.source, thumbnail: h.thumbnail })),
        };
      }
      const hits = await web.search.search(args.query, { limit });
      return { kind, hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })) };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(
        "web.search",
        `search failed: ${e instanceof Error ? e.message : String(e)}`,
        null,
        "try once more, or go on without it",
      );
    }
  },
});

export const readPage = defineTool({
  name: "read_page",
  description:
    "Read a web page as text, up to maxChars (default 8000). Pages on private or local addresses are refused. Write what matters into notes: the text does not survive compaction, the notes do.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  input: z.object({
    url: z.string().url(),
    maxChars: z.number().int().min(500).max(20_000).optional(),
  }),
  output: z.object({
    url: z.string(),
    status: z.number(),
    title: z.string().nullable(),
    text: z.string(),
    truncated: z.boolean(),
  }),
  async run(args, call) {
    const web = call.ctx.web;
    if (!web) throw unavailable("read_page", NO_WEB, HOW);
    const max = args.maxChars ?? DEFAULT_PAGE_CHARS;
    let page: Awaited<ReturnType<typeof web.fetcher.fetch>>;
    try {
      page = await web.fetcher.fetch(args.url);
    } catch (e) {
      throw new ToolError(
        "web.fetch",
        `${args.url}: ${e instanceof Error ? e.message : String(e)}`,
        null,
        "try another page",
      );
    }
    if (page.status >= 400)
      throw new ToolError("web.status", `${args.url} answered ${page.status}`, null, "try another page");
    const isHtml = /html|xml/i.test(page.contentType) || /^\s*</.test(page.body);
    const text = (isHtml ? htmlToText(page.body) : page.body).replace(/\n{3,}/g, "\n\n").trim();
    const title =
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.body)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
    return {
      url: page.url,
      status: page.status,
      title,
      text: text.length > max ? `${text.slice(0, max)} ...` : text,
      truncated: page.truncated || text.length > max,
    };
  },
});
