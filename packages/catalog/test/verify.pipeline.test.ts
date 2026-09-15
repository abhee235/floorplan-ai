import { describe, expect, it } from "vitest";
import {
  type ExtractInput,
  ensureSeed,
  type ProductProposal,
  type ProductProposalInput,
  type ProposalExtractor,
  ProductProposal as ProposalSchema,
  rankHits,
  SEED_LIBRARY,
  type SearchHit,
  staticFetcher,
  staticSearch,
  type VerifyDeps,
  VerifyInputError,
  VerifyUnavailable,
  verifyProduct,
} from "../src/index.js";
import { CatalogStore } from "../src/node.js";

const T0 = "2026-09-15T12:00:00.000Z";

// Spec-sheet style fixture pages. The numbers are the test's own "spec sheet": PRD P1-2 asks that the
// verified dimensions land within 2 percent of what the sheet states.
interface Sheet {
  url: string;
  make: string;
  model: string;
  diag: number;
  mm: [number, number, number]; // w, h, d as sheets write them
  kg: number;
  vesa: string;
  watts: number;
  format: "samsung" | "lg";
}

const SHEETS: Sheet[] = [
  {
    url: "https://www.samsung.com/us/business/displays/4k-uhd/qm75c/",
    make: "Samsung",
    model: "QM75C",
    diag: 75,
    mm: [1673.4, 963.2, 59.9],
    kg: 31.9,
    vesa: "400x400",
    watts: 185,
    format: "samsung",
  },
  {
    url: "https://www.samsung.com/us/business/displays/4k-uhd/qm85c/",
    make: "Samsung",
    model: "QM85C",
    diag: 85,
    mm: [1899.4, 1090.8, 60.4],
    kg: 43.5,
    vesa: "600x400",
    watts: 245,
    format: "samsung",
  },
  {
    url: "https://www.lg.com/us/business/digital-signage/lg-75uh5j-h",
    make: "LG",
    model: "75UH5J",
    diag: 75,
    mm: [1679.4, 969.1, 69.9],
    kg: 33.6,
    vesa: "400x400",
    watts: 230,
    format: "lg",
  },
];

function html(s: Sheet): string {
  const [w, h, d] = s.mm;
  if (s.format === "samsung")
    return `<html><head><title>${s.make} ${s.model}</title><script>window.x = "1 x 2 x 3 mm"</script></head><body>
      <h1>${s.diag}&quot; ${s.model} UHD 4K display</h1>
      <table>
        <tr><th>Diagonal Size</th><td>${s.diag}"</td></tr>
        <tr><th>Resolution</th><td>3840 x 2160</td></tr>
        <tr><th>Set Dimension without Stand (WxHxD)</th><td>${w} x ${h} x ${d} mm</td></tr>
        <tr><th>Set Weight without Stand</th><td>${s.kg} kg</td></tr>
        <tr><th>VESA Mount</th><td>${s.vesa.replace("x", " x ")} mm</td></tr>
        <tr><th>Power Consumption (Typical)</th><td>${s.watts} W</td></tr>
      </table></body></html>`;
  return `<html><body><h1>${s.make} ${s.model}-H</h1><dl>
      <dt>Screen size</dt><dd>${s.diag} inch</dd><dt>Native resolution</dt><dd>3840 x 2160</dd>
      <dt>Dimensions (mm) W x H x D</dt><dd>${w.toLocaleString("en-US")} x ${h} x ${d}</dd>
      <dt>Weight (kg)</dt><dd>${s.kg}</dd><dt>VESA</dt><dd>${s.vesa.replace("x", " x ")}</dd>
      <dt>Power consumption typical</dt><dd>${s.watts}W</dd></dl></body></html>`;
}

const RETAILER = "https://www.av-retailer.example/p/";
const OTHER = "https://www.samsung.com/us/business/displays/4k-uhd/qb75c/";

/** A stand-in for the verifier model: reads the sheet back as a model would, and counts calls. */
function fakeExtractor(
  answers: (input: ExtractInput) => ProductProposalInput | null,
): ProposalExtractor & { calls: ExtractInput[] } {
  const calls: ExtractInput[] = [];
  return {
    id: "fake-model",
    calls,
    async extract(input) {
      calls.push(input);
      const a = answers(input);
      return a ? ProposalSchema.parse(a) : null;
    },
  };
}

function proposalFor(s: Sheet, over: Partial<ProductProposalInput> = {}): ProductProposalInput {
  const [w, h, d] = s.mm;
  return {
    found: true,
    make: s.make,
    model: s.model,
    name: `${s.make} ${s.model}`,
    category: "display",
    dims: { w: Math.round(w), d: Math.round(d), h: Math.round(h) },
    weightKg: s.kg,
    mount: { kinds: ["wall"], vesa: s.vesa },
    specs: { diagonalIn: s.diag, resolution: "3840x2160", vesa: s.vesa, powerW: s.watts },
    fieldSources: { dims: s.url },
    ...over,
  };
}

function setup(
  options: {
    search?: boolean;
    extractor?: ProposalExtractor | null;
    extraPages?: Record<string, string>;
  } = {},
) {
  const store = CatalogStore.open(":memory:");
  ensureSeed(store, T0);
  const pages: Record<string, string> = {
    [OTHER]: "<html><body><h1>Samsung QB75C</h1><p>A different display.</p></body></html>",
    ...options.extraPages,
  };
  for (const s of SHEETS) {
    pages[s.url] = html(s);
    pages[`${RETAILER}${s.model.toLowerCase()}`] = html(s).replace(/<h1>/, "<h1>Buy ");
  }
  const fetcher = staticFetcher(pages);
  const search = staticSearch((q): SearchHit[] => {
    const sheet = SHEETS.find((s) => q.toLowerCase().includes(s.model.toLowerCase()));
    const hits: SearchHit[] = [{ url: OTHER, title: "QB75C", snippet: "" }];
    if (sheet)
      hits.unshift(
        { url: `${RETAILER}${sheet.model.toLowerCase()}`, title: "retailer", snippet: "" },
        { url: sheet.url, title: "manufacturer", snippet: "" },
      );
    return hits;
  });
  const extractor =
    options.extractor === undefined
      ? fakeExtractor((input) => {
          const sheet = SHEETS.find((s) => s.model === input.model);
          return sheet ? proposalFor(sheet) : { found: false, make: input.make, model: input.model };
        })
      : options.extractor;
  let n = 0;
  let clock = T0;
  const deps: VerifyDeps = {
    store,
    search: options.search === false ? null : search,
    fetcher,
    extractor,
    now: () => clock,
    newRunId: () => `vrun_${++n}`,
  };
  return { store, deps, fetcher, extractor, setClock: (t: string) => (clock = t) };
}

describe("verify_product pipeline (PRD P1-2, ADR-008 D3)", () => {
  it("P1-2 acceptance: three known displays verify with dimensions within 2 percent of the sheet and a source URL", async () => {
    const { store, deps } = setup();
    for (const s of SHEETS) {
      const out = await verifyProduct(deps, {
        make: s.make === "LG" ? "LG Electronics" : s.make,
        model: s.model,
      });
      expect(out.status, s.model).toBe("verified");
      expect(out.sources, s.model).toContain(s.url);
      const [w, h, d] = s.mm;
      const dims = out.product?.dims as { w: number; d: number; h: number };
      expect(Math.abs(dims.w - w) / w, `${s.model} w`).toBeLessThan(0.02);
      expect(Math.abs(dims.h - h) / h, `${s.model} h`).toBeLessThan(0.02);
      expect(Math.abs(dims.d - d) / d, `${s.model} d`).toBeLessThan(0.02);
      // the seed record is the one updated, still owned by the seed library
      expect(out.productId).toBe(s.make === "LG" ? "lg-75uh5j" : `samsung-${s.model.toLowerCase()}`);
      expect(store.ownerOf(out.productId as string)).toBe("seed");
      const saved = store.get(out.productId as string);
      expect(saved?.verification).toMatchObject({ status: "verified", verifiedAt: T0 });
      expect(saved?.specs.powerW).toBe(s.watts);
      expect(saved?.weightKg).toBe(s.kg);
    }
    expect(store.search({ query: "qm75c" }).hits[0]?.verified).toBe(true);
  });

  it("P1-2 acceptance: an invented model is rejected, nothing is saved, and the model is never asked", async () => {
    const { store, deps, extractor } = setup();
    const before = store.count();
    const out = await verifyProduct(deps, { make: "Samsung", model: "QX99Z" });
    expect(out).toMatchObject({
      status: "rejected",
      productId: null,
      confidence: 0,
      product: null,
      sources: [],
    });
    expect(out.notes.join(" ")).toContain("no page names Samsung QX99Z");
    expect(store.count()).toBe(before);
    expect((extractor as unknown as { calls: unknown[] }).calls).toHaveLength(0);
    expect(store.runs({ model: "QX99Z" })).toMatchObject([{ outcome: "rejected", productId: null }]);
  });

  it("fetches at most three pages, manufacturer pages first, and records the run", async () => {
    const { store, deps, fetcher } = setup();
    const out = await verifyProduct(deps, { make: "Samsung", model: "QM75C" });
    expect(fetcher.requested).toEqual([SHEETS[0]?.url, OTHER, `${RETAILER}qm75c`]);
    const [run] = store.runs({ productId: "samsung-qm75c" });
    expect(run).toMatchObject({
      id: out.runId,
      outcome: "verified",
      provider: "static+fake-model",
      queries: ["Samsung QM75C specifications", "site:samsung.com QM75C"],
    });
    expect(
      rankHits(
        [
          { url: "https://x.example/a", title: "", snippet: "" },
          { url: "https://www.samsung.com/a", title: "", snippet: "" },
          { url: "https://x.example/a#reviews", title: "", snippet: "" },
        ],
        "Samsung",
      ).map((h) => h.url),
    ).toEqual(["https://www.samsung.com/a", "https://x.example/a"]);
  });

  it("step 2: a current verified record answers without searching; force and an expired price search again", async () => {
    const { store, deps, fetcher, setClock } = setup();
    await verifyProduct(deps, { make: "Samsung", model: "QM75C" });
    const fetched = fetcher.requested.length;
    const again = await verifyProduct(deps, { make: "samsung", model: "qm 75c" });
    expect(again).toMatchObject({
      cached: true,
      status: "verified",
      productId: "samsung-qm75c",
      runId: null,
    });
    expect(fetcher.requested.length).toBe(fetched);
    await verifyProduct(deps, { make: "Samsung", model: "QM75C", force: true });
    expect(fetcher.requested.length).toBe(fetched + 3);
    // a record with an expired price is re-verified
    const p = store.get("samsung-qm75c");
    if (!p) throw new Error("missing");
    store.saveVerified(
      {
        ...p,
        price: {
          amount: 1,
          currency: "USD",
          type: "street",
          sourceUrl: null,
          capturedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      },
      T0,
    );
    setClock("2026-09-20T00:00:00.000Z");
    const expired = await verifyProduct(deps, { make: "Samsung", model: "QM75C" });
    expect(expired.cached).toBe(false);
  });

  it("step 7: a manual record is never overridden, even with no search provider at all", async () => {
    const { deps } = setup({ search: false });
    const out = await verifyProduct(deps, { make: "Generic", model: "Door 900" });
    expect(out).toMatchObject({ status: "manual", cached: true, productId: "generic-door-900" });
  });

  it("verified fields live in an overlay that a newer seed version does not erase", async () => {
    const { store, deps } = setup();
    await verifyProduct(deps, { make: "Samsung", model: "QM75C" });
    expect(store.get("samsung-qm75c")?.dims).toEqual({ w: 1673, d: 60, h: 963 });
    store.installLibrary({ ...SEED_LIBRARY, version: "1.0.1" }, "2026-09-16T00:00:00.000Z");
    const after = store.get("samsung-qm75c");
    expect(after?.dims).toEqual({ w: 1673, d: 60, h: 963 });
    expect(after?.verification.status).toBe("verified");
    expect(after?.tags).toContain("display"); // library fields still come from the library
  });

  it("without a search provider: unavailable unless sources are given", async () => {
    const { deps } = setup({ search: false });
    await expect(verifyProduct(deps, { make: "Samsung", model: "QM75C" })).rejects.toBeInstanceOf(
      VerifyUnavailable,
    );
    await expect(verifyProduct(deps, { make: "Samsung", model: "QM75C" })).rejects.toThrow(
      "no search provider is configured",
    );
    const out = await verifyProduct(deps, {
      make: "Samsung",
      model: "QM75C",
      sources: [SHEETS[0]?.url as string],
    });
    expect(out.status).toBe("verified");
  });

  it("the development path: an agent passes sources and its own proposal; the host still checks the pages", async () => {
    const { store, deps } = setup({ search: false, extractor: null });
    const sheet = SHEETS[1] as Sheet;
    await expect(
      verifyProduct(deps, { make: "Samsung", model: "QM85C", sources: [sheet.url] }),
    ).rejects.toThrow("no verifier model is configured");
    const good = await verifyProduct(deps, {
      make: "Samsung",
      model: "QM85C",
      sources: [sheet.url],
      proposal: proposalFor(sheet),
    });
    expect(good.status).toBe("verified");
    // a new model whose claimed size is not on the page: unverified and never saved
    const extra = "https://www.samsung.com/us/business/displays/4k-uhd/qm65c/";
    const { store: s2, deps: d2 } = setup({
      search: false,
      extractor: null,
      extraPages: { [extra]: "<h1>Samsung QM65C</h1><p>65 inch 4K display, resolution 3840 x 2160</p>" },
    });
    const guessed = await verifyProduct(d2, {
      make: "Samsung",
      model: "QM65C",
      sources: [extra],
      proposal: {
        found: true,
        make: "Samsung",
        model: "QM65C",
        category: "display",
        dims: { w: 1450, d: 30, h: 835 },
      },
    });
    expect(guessed.status).toBe("unverified");
    expect(guessed.productId).toBeNull();
    expect(guessed.notes.join(" ")).toContain("no catalog record was created");
    expect(s2.findByMakeModel("Samsung", "QM65C")).toBeNull();
    expect(store.count()).toBe(s2.count());
  });

  it("a new product whose dimensions a page states is created, unverified when only a retailer says so", async () => {
    const retailer = "https://shop.example/yealink-a40";
    const { store, deps } = setup({
      search: false,
      extractor: null,
      extraPages: {
        [retailer]: "<h1>Yealink MeetingBar A40</h1><p>Dimensions 830 x 97 x 106 mm, weight 2.9 kg</p>",
      },
    });
    const out = await verifyProduct(deps, {
      make: "Yealink",
      model: "MeetingBar A40",
      category: "video-bar",
      sources: [retailer],
      proposal: {
        found: true,
        make: "Yealink",
        model: "MeetingBar A40",
        category: "video-bar",
        dims: { w: 830, d: 97, h: 106 },
        weightKg: 2.9,
      },
    });
    expect(out.status).toBe("unverified");
    expect(out.productId).toBe("yealink-meetingbar-a40");
    const saved = store.get("yealink-meetingbar-a40");
    expect(saved).toMatchObject({ category: "video-bar", dims: { w: 830, d: 97, h: 106 }, weightKg: 2.9 });
    expect(saved?.verification).toMatchObject({
      status: "unverified",
      sources: [retailer],
      verifiedAt: null,
    });
    expect(saved?.mount.kinds).toEqual(["wall", "table"]);
    expect(store.ownerOf("yealink-meetingbar-a40")).toBeNull();
  });

  it("an unverified attempt never downgrades a verified record", async () => {
    const { store, deps } = setup();
    await verifyProduct(deps, { make: "Samsung", model: "QM75C" });
    const retailerOnly = await verifyProduct(deps, {
      make: "Samsung",
      model: "QM75C",
      force: true,
      sources: [`${RETAILER}qm75c`],
    });
    expect(retailerOnly.status).toBe("unverified");
    expect(retailerOnly.notes.join(" ")).toContain("is kept");
    expect(store.get("samsung-qm75c")?.verification.status).toBe("verified");
  });

  it("a failing model and unreadable pages become notes, not crashes; bad input is an input error", async () => {
    const broken: ProposalExtractor = {
      id: "broken",
      async extract(): Promise<ProductProposal | null> {
        throw new Error("no valid JSON after 3 attempts");
      },
    };
    const pdf = "https://www.samsung.com/qm75c.pdf";
    const { deps } = setup({ extractor: broken });
    (deps.fetcher as ReturnType<typeof staticFetcher>).fetch = async (url) =>
      url === pdf
        ? { url, status: 200, contentType: "application/pdf", body: "%PDF", truncated: false }
        : { url, status: 200, contentType: "text/html", body: html(SHEETS[0] as Sheet), truncated: false };
    const out = await verifyProduct(deps, {
      make: "Samsung",
      model: "QM75C",
      sources: [pdf, SHEETS[0]?.url as string],
    });
    expect(out.status).toBe("unverified");
    expect(out.notes.join(" | ")).toContain("the verifier model failed: no valid JSON after 3 attempts");
    expect(out.notes.join(" | ")).toContain("application/pdf is not read");
    await expect(
      verifyProduct(deps, { make: "Samsung", model: "QM75C", sources: ["file:///etc/passwd"] }),
    ).rejects.toBeInstanceOf(VerifyInputError);
    await expect(
      verifyProduct(deps, {
        make: "Samsung",
        model: "QM75C",
        sources: [pdf],
        proposal: { found: "yes" } as never,
      }),
    ).rejects.toThrow(/proposal:/);
  });
});
