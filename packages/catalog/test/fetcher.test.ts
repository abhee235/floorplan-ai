import { describe, expect, it } from "vitest";
import { FetchRefused, httpPageFetcher, isPrivateAddress } from "../src/node.js";

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(status >= 300 && status < 400 ? null : body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

describe("page fetcher guard (ADR-008 D3 step 4)", () => {
  it("classifies loopback, private, link-local, CGNAT, multicast and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:1.1.1.1"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses hosts that resolve to local addresses and non-http schemes, unless private pages are allowed", async () => {
    const calls: string[] = [];
    const fetch = async (u: string) => {
      calls.push(u);
      return response(200, "<p>ok</p>");
    };
    const guarded = httpPageFetcher({ fetch, resolve: async () => ["192.168.0.10"] });
    await expect(guarded.fetch("http://intranet.example/")).rejects.toBeInstanceOf(FetchRefused);
    await expect(guarded.fetch("http://127.0.0.1:4310/")).rejects.toThrow(/private or local/);
    await expect(guarded.fetch("ftp://example.com/x")).rejects.toThrow(/only http and https/);
    expect(calls).toEqual([]);
    const open = httpPageFetcher({ fetch, resolve: async () => ["192.168.0.10"], allowPrivate: true });
    expect((await open.fetch("http://intranet.example/")).body).toBe("<p>ok</p>");
  });

  it("follows redirects checking every hop, and gives up after the limit", async () => {
    const publicResolve = async (host: string) =>
      host === "evil.example" ? ["127.0.0.1"] : ["93.184.216.34"];
    const hops: Record<string, Response | (() => Response)> = {};
    const fetch = async (u: string) => {
      const r = hops[u];
      if (!r) return response(404, "");
      return typeof r === "function" ? r() : r;
    };
    hops["https://a.example/"] = () => response(301, "", { location: "/b" });
    hops["https://a.example/b"] = () => response(200, "<h1>final</h1>");
    const f = httpPageFetcher({ fetch, resolve: publicResolve });
    expect(await f.fetch("https://a.example/")).toMatchObject({
      url: "https://a.example/b",
      status: 200,
      body: "<h1>final</h1>",
    });
    hops["https://c.example/"] = () => response(302, "", { location: "http://evil.example/admin" });
    await expect(f.fetch("https://c.example/")).rejects.toThrow(/evil.example resolves to a private/);
    hops["https://loop.example/"] = () => response(302, "", { location: "https://loop.example/" });
    await expect(
      httpPageFetcher({ fetch, resolve: publicResolve, maxRedirects: 2 }).fetch("https://loop.example/"),
    ).rejects.toThrow(/more than 2 redirects/);
  });

  it("stops reading at the byte cap and says so", async () => {
    const big = "x".repeat(10_000);
    const f = httpPageFetcher({
      fetch: async () => response(200, big),
      resolve: async () => ["93.184.216.34"],
      maxBytes: 1000,
    });
    const page = await f.fetch("https://big.example/");
    expect(page.body).toHaveLength(1000);
    expect(page.truncated).toBe(true);
  });
});
