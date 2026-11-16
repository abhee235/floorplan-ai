// @vitest-environment jsdom
//
// The catalog tab (P3-5): it searches through the host, narrows by category, lists products and generic
// shapes, and hands the picked piece to the item tool or to a replacement.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CatalogPanel, type CatalogSearch } from "../../src/editor/CatalogPanel.js";
import type { CatalogHit, CatalogPage } from "../../src/editor/catalog.js";
import type { Placeable } from "../../src/editor/item-tool.js";

beforeAll(() => {
  // cmdk keeps the highlighted option in view, and Radix measures; jsdom does neither
  Element.prototype.scrollIntoView ??= () => {};
  // Radix Select captures the pointer
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const hit = (id: string, over: Partial<CatalogHit> = {}): CatalogHit => ({
  id,
  name: `Acme ${id}`,
  make: "Acme",
  model: id.toUpperCase(),
  category: "chair",
  dims: { w: 600, d: 580, h: 1040 },
  verified: true,
  price: null,
  ...over,
});

const TABLE = { kind: "table", size: { w: 2400, d: 1200, h: 750 }, shape: "rect" };

function setup(
  pages: (args: CatalogSearch) => CatalogPage = (args) =>
    args.kind === "recipe"
      ? {
          hits: [hit("recipe:table", { name: "Meeting table", category: "table", recipe: TABLE })],
          total: 1,
          cursor: null,
        }
      : { hits: [hit("c1", { verified: false, status: "unverified" }), hit("c2")], total: 2, cursor: null },
  replacing: string | null = null,
) {
  const calls: CatalogSearch[] = [];
  const placed: Placeable[] = [];
  const replaced: Placeable[] = [];
  const search = vi.fn(async (args: CatalogSearch) => {
    calls.push(args);
    return pages(args);
  });
  const ui = (name: string | null) => (
    <CatalogPanel
      search={search}
      onPlace={(p) => placed.push(p)}
      onReplace={async (p) => {
        replaced.push(p);
      }}
      replacing={name}
    />
  );
  const view = render(ui(replacing));
  return { calls, placed, replaced, view, rerender: (name: string | null) => view.rerender(ui(name)) };
}

describe("the catalog tab (P3-5)", () => {
  it("lists the catalog before anything is typed: products, then generic shapes", async () => {
    const { calls } = setup();
    await screen.findByText("2 products, 1 generic");
    expect(calls).toEqual([
      { kind: "product", query: "" },
      { kind: "recipe", query: "" },
    ]);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toContain("Acme c1");
    expect(options[0]).toContain("Unverified");
    expect(options[2]).toContain("Meeting table");
    // the size is said in full, not as "times"
    expect(screen.getAllByText("600 wide, 580 deep, 1040 high, in millimetres").length).toBeGreaterThan(0);
  });

  it("searches as it is typed, once the typing settles", async () => {
    const { calls } = setup();
    await screen.findByText("2 products, 1 generic");
    await userEvent.type(screen.getByRole("combobox", { name: "Search the catalog" }), "aeron");
    await waitFor(() => expect(calls.at(-2)).toEqual({ kind: "product", query: "aeron" }));
    // one search per settled query, not one per key
    expect(calls.filter((c) => c.kind === "product" && c.query.startsWith("aer"))).toHaveLength(1);
  });

  it("places the highlighted piece on Enter, and shows what it is", async () => {
    const { placed } = setup();
    await screen.findByText("2 products, 1 generic");
    const input = screen.getByRole("combobox", { name: "Search the catalog" });
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}");
    const picked = screen.getByRole("region", { name: "Picked piece" });
    expect(picked.textContent).toContain("Acme c2");
    expect(picked.textContent).toContain("Acme C2 · Chair");
    await userEvent.keyboard("{Enter}");
    expect(placed.map((p) => p.id)).toEqual(["c2"]);
    // a generic shape is placed as its recipe
    await userEvent.click(screen.getByRole("option", { name: /Meeting table/ }));
    expect(placed.at(-1)?.ref).toEqual({ kind: "recipe", recipe: TABLE });
  });

  it("warns that an unverified size may be wrong", async () => {
    setup();
    await screen.findByText("2 products, 1 generic");
    expect(screen.getByRole("region", { name: "Picked piece" }).textContent).toContain(
      "Unverified: its size and price may be wrong.",
    );
  });

  it("replaces the selected item only when exactly one is selected", async () => {
    const { replaced, rerender } = setup();
    await screen.findByText("2 products, 1 generic");
    const button = screen.getByRole("button", { name: "Replace selected" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Select one item on the plan to replace it.")).toBeTruthy();
    rerender("Acme chair");
    await userEvent.click(screen.getByRole("button", { name: "Replace selected" }));
    expect(replaced.map((p) => p.id)).toEqual(["c1"]);
  });

  it("narrows to a category, and pages on", async () => {
    let page = 0;
    const { calls } = setup((args) => {
      if (args.kind === "recipe") return { hits: [], total: 0, cursor: null };
      page += 1;
      return args.cursor
        ? { hits: [hit("t3", { category: "table" })], total: 3, cursor: null }
        : {
            hits: [hit("t1", { category: "table" }), hit("t2", { category: "table" })],
            total: 3,
            cursor: "p2",
          };
    });
    await screen.findByText("3 products");
    await userEvent.click(screen.getByRole("combobox", { name: "Category" }));
    await userEvent.click(screen.getByRole("option", { name: "Table" }));
    await waitFor(() => expect(calls.at(-2)).toEqual({ kind: "product", query: "", category: "table" }));
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: "Show more products" }));
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(calls.at(-1)).toEqual({ kind: "product", query: "", category: "table", cursor: "p2" });
    expect(page).toBeGreaterThan(1);
  });

  it("says so when the host cannot search", async () => {
    setup(() => {
      throw new Error("the host is not connected");
    });
    await screen.findByText("The catalog could not be searched: the host is not connected");
  });
});
