// @vitest-environment jsdom
//
// A 3D model made into a product (ADR-010 D10, P3-8): the size it has once turned and stood up, in its
// file's units; the size asked for instead; and the dialog that asks.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as THREE from "three";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ModelChoice, ModelImportDialog } from "../../src/editor/ModelImportDialog.js";
import {
  MODEL_CATEGORIES,
  modelNameFromFile,
  shapedExtent,
  sizeInMm,
  suggestUnits,
  withSide,
} from "../../src/editor/model-import.js";

beforeAll(() => {
  // Radix's checkbox measures itself, and its select captures the pointer
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

describe("what the model import works out", () => {
  it("turns and stands up a model's box exactly, a quarter turn at a time", () => {
    const lying = { w: 80, d: 95, h: 40 }; // a chair made with z up arrives on its back
    expect(shapedExtent(lying, 0, 1)).toEqual({ w: 80, d: 40, h: 95 });
    expect(shapedExtent(lying, 1, 1)).toEqual({ w: 40, d: 80, h: 95 });
    expect(shapedExtent(lying, 2, 2)).toEqual(lying);
  });

  it("reads the file's numbers in its units, guessing centimetres for furniture tens of units long", () => {
    expect(sizeInMm({ w: 80, d: 70, h: 95 }, "cm")).toEqual({ w: 800, d: 700, h: 950 });
    expect(sizeInMm({ w: 0.0001, d: 1, h: 1 }, "m").w).toBe(1); // a side is at least a millimetre
    expect(suggestUnits({ w: 0.8, d: 0.7, h: 0.95 })).toBe("m");
    expect(suggestUnits({ w: 80, d: 70, h: 95 })).toBe("cm");
    expect(suggestUnits({ w: 800, d: 700, h: 2950 })).toBe("mm");
  });

  it("keeps the other sides in proportion when asked, and leaves them alone when not", () => {
    const size = { w: 800, d: 700, h: 950 };
    expect(withSide(size, "w", 1600, true)).toEqual({ w: 1600, d: 1400, h: 1900 });
    expect(withSide(size, "w", 1600, false)).toEqual({ w: 1600, d: 700, h: 950 });
  });

  it("offers every category but doors and windows, and names the product from the file", () => {
    expect(MODEL_CATEGORIES.map((c) => c.value)).not.toContain("door");
    expect(MODEL_CATEGORIES.map((c) => c.value)).toContain("chair");
    expect(modelNameFromFile("C:\\models\\lounge_chair-02.glb")).toBe("Lounge chair 02");
  });
});

describe("the model import dialog", () => {
  const model: ModelChoice = {
    fileName: "lounge_chair.glb",
    extent: { w: 80, d: 95, h: 40 },
    scene: new THREE.Group(),
    converted: false,
  };
  const show = (props: Partial<Parameters<typeof ModelImportDialog>[0]> = {}) => {
    const handlers = { onCancel: vi.fn(), onImport: vi.fn() };
    render(
      <ModelImportDialog model={model} busy={false} error={null} preview={null} {...handlers} {...props} />,
    );
    return handlers;
  };
  const sides = () =>
    ["Width", "Depth", "Height"].map((s) => (screen.getByLabelText(s) as HTMLInputElement).value);

  it("starts from the file's name and likely units, and asks for the model's own size when left alone", async () => {
    const { onImport } = show();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Lounge chair");
    expect(sides()).toEqual(["800", "950", "400"]);
    // it lies on its back: standing it up swaps depth and height, and the preview's words say so
    await userEvent.setup().click(screen.getByRole("button", { name: /Stand up/ }));
    expect(sides()).toEqual(["800", "400", "950"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Add to catalog" }));
    expect(onImport).toHaveBeenCalledWith({
      name: "Lounge chair",
      category: "other",
      units: "cm",
      turn: 0,
      tip: 1,
      size: null,
    });
  });

  it("sends a size typed over the model's, in proportion unless told otherwise", async () => {
    const { onImport } = show();
    const user = userEvent.setup();
    const width = screen.getByLabelText("Width");
    await user.clear(width);
    await user.type(width, "1600");
    expect(sides()).toEqual(["1600", "1900", "800"]);
    expect(screen.getByText(/The model measures 800 × 950 × 400 mm/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Keep proportions" }));
    const height = screen.getByLabelText("Height");
    await user.clear(height);
    await user.type(height, "750");
    expect(sides()).toEqual(["1600", "1900", "750"]);
    await user.click(screen.getByRole("button", { name: "Add to catalog" }));
    expect(onImport.mock.calls[0]?.[0].size).toEqual({ w: 1600, d: 1900, h: 750 });
  });

  it("says why the host refused, waits while it works, and works without a preview", () => {
    show({ error: "the model is compressed with Draco, which this app does not decode", busy: true });
    expect(screen.getByRole("alert").textContent).toContain("Draco");
    expect((screen.getByRole("button", { name: "Add to catalog" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/The preview needs WebGL/)).toBeTruthy();
  });
});
