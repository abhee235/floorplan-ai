// The page fetcher the host uses for verification (ADR-008 D3 step 4). Node-only: it resolves host names
// so pages on loopback, link-local and private networks are refused unless allowed, follows at most a
// few redirects checking every hop, and stops reading at a byte cap. A name that resolves differently
// between the check and the request can still slip past; for a single-user local app the guard is about
// accidents and pasted links, not a hostile network.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchedPage, FetchFn, PageFetcher } from "./verify/web.js";

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true; // not an address at all
}

export interface HttpFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivate?: boolean;
  userAgent?: string;
  fetch?: FetchFn;
  resolve?: (host: string) => Promise<string[]>;
}

export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefused";
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export function httpPageFetcher(options: HttpFetcherOptions = {}): PageFetcher {
  const f = options.fetch ?? (globalThis.fetch as FetchFn);
  const resolve = options.resolve ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 3_000_000;
  const maxRedirects = options.maxRedirects ?? 4;
  const userAgent = options.userAgent ?? "floorplan-ai product verifier (+local)";

  async function guard(url: URL): Promise<void> {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new FetchRefused(`only http and https: ${url}`);
    if (options.allowPrivate) return;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (addresses.length === 0) throw new FetchRefused(`${host} does not resolve`);
    const bad = addresses.find(isPrivateAddress);
    if (bad) throw new FetchRefused(`${host} resolves to a private or local address (${bad})`);
  }

  return {
    async fetch(input, { signal } = {}) {
      const timer = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timer]) : timer;
      let url = new URL(input);
      for (let hop = 0; ; hop += 1) {
        await guard(url);
        const res = await f(url.toString(), {
          redirect: "manual",
          signal: combined,
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          if (hop >= maxRedirects)
            throw new FetchRefused(`more than ${maxRedirects} redirects from ${input}`);
          url = new URL(res.headers.get("location") as string, url);
          continue;
        }
        const { body, truncated } = await readCapped(res, maxBytes);
        const page: FetchedPage = {
          url: url.toString(),
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          body,
          truncated,
        };
        return page;
      }
    },
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { body: new TextDecoder("utf-8").decode(bytes), truncated };
}
