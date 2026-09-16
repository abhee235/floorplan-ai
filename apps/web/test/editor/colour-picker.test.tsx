// @vitest-environment jsdom
//
// The colour picker's own controls (P3-5 follow-up): the numbers in each colour model, the hue slider, the
// colour guide, and how it closes. What a picked colour does to a row is tested in property-field.test.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ColourPicker } from "../../src/editor/ColourPicker.js";

beforeAll(() => {
  // Radix measures the slider and positions the lists with these, which jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

afterEach(cleanup);

function setup(value = "#C9A27E") {
  const picked: string[] = [];
  const closed: boolean[] = [];
  const ui = (v: string) => (
    <ColourPicker
      label="Colour of top"
      value={v}
      onPick={(hex) => {
        picked.push(hex);
        view.rerender(ui(hex));
      }}
      onClose={(keep) => closed.push(keep)}
    />
  );
  const view = render(ui(value));
  return {
    picked,
    closed,
    user: userEvent.setup(),
    trigger: screen.getByRole("button", { name: "Colour of top, picker" }),
  };
}

describe("the colour picker", () => {
  it("opens as a named dialog on its swatch, starting on the square", async () => {
    const { trigger, user } = setup();
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Colour of top, picker" })).toBeDefined();
    const square = screen.getByRole("slider", { name: "Saturation and brightness" });
    expect(document.activeElement).toBe(square);
    expect(square.getAttribute("aria-valuetext")).toBe("Saturation 37 percent, brightness 79 percent");
  });

  it("takes a hex colour as it is typed, with or without its #", async () => {
    const { trigger, user, picked } = setup();
    await user.click(trigger);
    const hex = screen.getByRole("textbox", { name: "Hex colour" }) as HTMLInputElement;
    expect(hex.value).toBe("C9A27E");
    await user.clear(hex);
    await user.type(hex, "3e5");
    // three digits are a colour already
    expect(picked.at(-1)).toBe("#33EE55");
    await user.type(hex, "c76");
    expect(picked.at(-1)).toBe("#3E5C76");
  });

  it("speaks RGB, HSL, HSB and CMYK, and steps a number with the arrow keys", async () => {
    const { trigger, user, picked } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole("combobox", { name: "Colour model" }));
    await user.click(await screen.findByRole("option", { name: "RGB" }));
    const red = screen.getByRole("textbox", { name: "Red" }) as HTMLInputElement;
    expect(red.value).toBe("201");
    await user.clear(red);
    await user.type(red, "255");
    expect(picked.at(-1)).toBe("#FFA27E");
    const blue = screen.getByRole("textbox", { name: "Blue" });
    await user.click(blue);
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(picked.at(-1)).toBe("#FFA288");
    await user.click(screen.getByRole("combobox", { name: "Colour model" }));
    await user.click(await screen.findByRole("option", { name: "CMYK" }));
    expect(screen.getByRole("textbox", { name: "Black" })).toBeDefined();
  });

  it("turns the hue from its slider, and keeps the hue of a grey", async () => {
    const { trigger, user, picked } = setup("#808080");
    await user.click(trigger);
    const hue = screen.getByRole("slider", { name: "Hue" });
    hue.focus();
    await user.keyboard("{End}");
    expect(hue.getAttribute("aria-valuetext")).toBe("359 degrees");
    // a grey turned is still that grey, so nothing is picked, but the hue stays where it was put
    expect(picked).toEqual([]);
    screen.getByRole("slider", { name: "Saturation and brightness" }).focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(hue.getAttribute("aria-valuetext")).toBe("359 degrees");
    // saturated a little, the grey leans to the hue that was chosen: red, not the default
    expect(picked.at(-1)).toBe("#807373");
  });

  it("offers colours that go with this one", async () => {
    const { trigger, user, picked } = setup("#FF0000");
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Colour guide" }));
    const triad = screen.getByRole("group", { name: "Triad" });
    expect([...triad.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "#FF0000",
      "#00FF00",
      "#0000FF",
    ]);
    await user.click(triad.querySelectorAll("button")[1] as HTMLElement);
    expect(picked.at(-1)).toBe("#00FF00");
  });

  it("closes keeping the colour, or with Escape not keeping it", async () => {
    const { trigger, user, closed } = setup();
    await user.click(trigger);
    await user.click(trigger);
    expect(closed).toEqual([true]);
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(closed).toEqual([true, false]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
