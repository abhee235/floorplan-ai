// @vitest-environment jsdom
//
// A picture made into a material (P3-8): the dialog asks what to call it and how wide it is in reality,
// and works the height out from the picture's shape as the host will.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDTH_MM,
  heightFor,
  nameFromFile,
  TextureImportDialog,
  type TexturePicture,
} from "../../src/editor/TextureImportDialog.js";

afterEach(cleanup);

const picture: TexturePicture = { url: "blob:x", fileName: "grey-carpet_tile.jpg", width: 800, height: 400 };

describe("the picture-to-material dialog (P3-8)", () => {
  it("names a texture after its file, and works its height out from the picture's shape", () => {
    expect(nameFromFile("oak-plank_02.jpg")).toBe("Oak plank 02");
    expect(nameFromFile("C:\\photos\\slate.webp")).toBe("Slate");
    expect(nameFromFile(".png")).toBe("Imported texture");
    expect(heightFor(600, { width: 800, height: 400 })).toBe(300);
    expect(heightFor(10, { width: 4000, height: 1 })).toBe(1);
  });

  it("starts from the file's name and the usual width, and sends what was typed", async () => {
    const onImport = vi.fn();
    render(
      <TextureImportDialog
        picture={picture}
        busy={false}
        error={null}
        onCancel={() => {}}
        onImport={onImport}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Use a picture as a material" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Grey carpet tile");
    const width = screen.getByLabelText("Real width") as HTMLInputElement;
    expect(width.value).toBe(String(DEFAULT_WIDTH_MM));
    expect(screen.getByText("100 mm, from the picture's shape")).toBeTruthy();
    expect(screen.getByText("800 × 400 pixels")).toBeTruthy();
    const user = userEvent.setup();
    await user.clear(width);
    await user.type(width, "600");
    expect(screen.getByText("300 mm, from the picture's shape")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add material" }));
    expect(onImport).toHaveBeenCalledWith("Grey carpet tile", 600);
  });

  it("will not send a width outside what the host takes, nor a nameless texture", async () => {
    const onImport = vi.fn();
    render(
      <TextureImportDialog
        picture={picture}
        busy={false}
        error={null}
        onCancel={() => {}}
        onImport={onImport}
      />,
    );
    const user = userEvent.setup();
    const width = screen.getByLabelText("Real width");
    await user.clear(width);
    await user.type(width, "5");
    const add = screen.getByRole("button", { name: "Add material" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(width.getAttribute("aria-invalid")).toBe("true");
    await user.clear(width);
    await user.type(width, "300");
    await user.clear(screen.getByLabelText("Name"));
    expect(add.disabled).toBe(true);
    expect(onImport).not.toHaveBeenCalled();
  });

  it("says why the host refused, waits while it works, and suggests a smaller copy of a large picture", () => {
    const { rerender } = render(
      <TextureImportDialog
        picture={{ ...picture, width: 4000, height: 3000 }}
        busy
        error="the file is not a picture"
        onCancel={() => {}}
        onImport={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("the file is not a picture");
    expect((screen.getByRole("button", { name: "Add material" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("A smaller copy would look the same in the plan and use less memory."),
    ).toBeTruthy();
    rerender(
      <TextureImportDialog
        picture={null}
        busy={false}
        error={null}
        onCancel={() => {}}
        onImport={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
