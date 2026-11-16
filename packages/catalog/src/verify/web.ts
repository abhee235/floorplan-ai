// Search and fetch behind small interfaces (ADR-008 D3 step 3). Providers take an injected fetch so they
// stay testable offline and runnable in any JavaScript runtime; the Node page fetcher with its address
// guard lives behind "@fpv/catalog/store".

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface ImageHit {
  /** The picture itself. */
  url: string;
  title: string;
  /** The page it was found on. */
  source: string;
  thumbnail: string | null;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchHit[]>;
  /** Pictures rather than pages, for a provider that has an image index; SearXNG does, Brave's web endpoint does not. */
  images?(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<ImageHit[]>;
}

export interface FetchedPage {
  /** The final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface FetchedBytes {
  url: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

export interface PageFetcher {
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage>;
  /** The response as it came, for a picture; the same address guard and cap as a page. */
  fetchBytes?(url: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<FetchedBytes>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class SearchError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SearchError";
  }
}

async function json(provider: string, res: Response): Promise<unknown> {
  if (!res.ok) throw new SearchError(provider, `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new SearchError(provider, "the response is not JSON");
  }
}

/** Brave Search API: GET /res/v1/web/search with an X-Subscription-Token header. */
export function braveSearch(options: { apiKey: string; fetch?: FetchFn; endpoint?: string }): SearchProvider {
  const f = options.fetch ?? (globalThis.fetch as FetchFn);
  const endpoint = options.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
  return {
    id: "brave",
    async search(query, { limit = 10, signal } = {}) {
      const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`;
      const body = (await json(
        "brave",
        await f(url, {
          headers: { accept: "application/json", "x-subscription-token": options.apiKey },
          ...(signal ? { signal } : {}),
        }),
      )) as { web?: { results?: { url?: string; title?: string; description?: string }[] } };
      return (body.web?.results ?? [])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({ url: r.url as string, title: r.title ?? "", snippet: r.description ?? "" }))
        .slice(0, limit);
    },
  };
}

/** A SearXNG instance with the JSON format enabled: GET /search?q=..&format=json. */
export function searxngSearch(options: { baseUrl: string; fetch?: FetchFn }): SearchProvider {
  const f = options.fetch ?? (globalThis.fetch as FetchFn);
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    id: "searxng",
    async search(query, { limit = 10, signal } = {}) {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const body = (await json(
        "searxng",
        await f(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) }),
      )) as { results?: { url?: string; title?: string; content?: string }[] };
      return (body.results ?? [])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({ url: r.url as string, title: r.title ?? "", snippet: r.content ?? "" }))
        .slice(0, limit);
    },
    async images(query, { limit = 10, signal } = {}) {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=images`;
      const body = (await json(
        "searxng",
        await f(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) }),
      )) as { results?: { img_src?: string; thumbnail_src?: string; url?: string; title?: string }[] };
      return (body.results ?? [])
        .filter((r) => typeof r.img_src === "string" && /^https?:/.test(r.img_src))
        .map((r) => ({
          url: r.img_src as string,
          title: r.title ?? "",
          source: r.url ?? "",
          thumbnail: r.thumbnail_src ?? null,
        }))
        .slice(0, limit);
    },
  };
}

/** Fixed answers for tests and replays: a map from query to hits, or a function. */
export function staticSearch(
  answers: Record<string, SearchHit[]> | ((query: string) => SearchHit[]),
  pictures: Record<string, ImageHit[]> = {},
): SearchProvider {
  return {
    id: "static",
    async search(query, { limit = 10 } = {}) {
      const hits = typeof answers === "function" ? answers(query) : (answers[query] ?? []);
      return hits.slice(0, limit);
    },
    async images(query, { limit = 10 } = {}) {
      return (pictures[query] ?? []).slice(0, limit);
    },
  };
}

/** Fixed pages for tests: a map from URL to an HTML body or a full response. Unknown URLs are 404. */
export function staticFetcher(
  pages: Record<string, string | { status?: number; contentType?: string; body: string }>,
): PageFetcher & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async fetch(url) {
      requested.push(url);
      const p = pages[url];
      if (p === undefined) return { url, status: 404, contentType: "text/html", body: "", truncated: false };
      if (typeof p === "string")
        return { url, status: 200, contentType: "text/html", body: p, truncated: false };
      return {
        url,
        status: p.status ?? 200,
        contentType: p.contentType ?? "text/html",
        body: p.body,
        truncated: false,
      };
    },
    async fetchBytes(url) {
      // A fixture picture is written as base64 so a test can hold a real PNG in a string.
      const page = await this.fetch(url);
      const text = page.contentType.startsWith("image/") ? atob(page.body) : page.body;
      const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
      return { url: page.url, status: page.status, contentType: page.contentType, bytes, truncated: false };
    },
  };
}
