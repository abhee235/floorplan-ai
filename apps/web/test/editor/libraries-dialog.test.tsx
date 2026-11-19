// @vitest-environment jsdom
//
// The catalog's libraries (P3-8): what is installed, with what it holds; a built-in library is said to
// be one and cannot be removed; removing another asks first.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentsOf, LibrariesDialog, type LibraryRow } from "../../src/editor/LibrariesDialog.js";

afterEach(cleanup);

const row = (over: Partial<LibraryRow>): LibraryRow => ({
  id: "x",
  version: "1.0.0",
  name: "X",
  provider: null,
  licence: "CC0-1.0",
  installedAt: "2026-11-18T09:00:00.000Z",
  productCount: 0,
  textureCount: 0,
  assetCount: 0,
  builtIn: false,
  ...over,
});
const SEED = row({ id: "seed", name: "Seed products", licence: "own", productCount: 21, builtIn: true });
const ACME = row({
  id: "acme",
  name: "Acme finishes",
  version: "2.1.0",
  provider: "Acme",
  textureCount: 4,
  productCount: 1,
});

function show(props: Partial<Parameters<typeof LibrariesDialog>[0]> = {}) {
  const handlers = { onOpenChange: vi.fn(), onInstall: vi.fn(), onUninstall: vi.fn() };
  render(
    <LibrariesDialog
      open
      libraries={[ACME, SEED]}
      busy={false}
      error={null}
      notice={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("the libraries dialog (P3-8)", () => {
  it("says what each library holds, leaving out what it has none of", () => {
    expect(contentsOf({ productCount: 1, textureCount: 4, assetCount: 0 })).toBe("1 product · 4 materials");
    expect(contentsOf({ productCount: 0, textureCount: 0, assetCount: 2 })).toBe("2 models");
    expect(contentsOf({ productCount: 0, textureCount: 0, assetCount: 0 })).toBe("empty");
  });

  it("lists each library with its maker, licence and contents; a built-in one is said to be one", () => {
    show();
    const items = within(screen.getByRole("list", { name: "Installed libraries" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Acme finishes");
    expect(items[0]?.textContent).toContain("2.1.0");
    expect(items[0]?.textContent).toContain("Acme · CC0 · 1 product · 4 materials");
    expect(items[1]?.textContent).toContain("Built in");
    expect(within(items[1] as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("asks before removing, and keeps the library when told to", async () => {
    const { onUninstall } = show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove Acme finishes 2.1.0" }));
    expect(screen.getByText("Remove Acme finishes 2.1.0? Its files go from this installation.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(onUninstall).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove Acme finishes 2.1.0" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onUninstall).toHaveBeenCalledWith("acme", "2.1.0");
  });

  it("asks for a zip to install, says why one was refused or what one did, and waits while it works", async () => {
    const { onInstall } = show({ error: "there is no library.json in this zip" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Install a library…" }));
    expect(onInstall).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("there is no library.json in this zip");
    cleanup();
    show({ notice: "Installed Acme finishes 2.1.0: 1 product · 4 materials.", busy: true });
    expect(screen.getByRole("status").textContent).toContain("Installed Acme finishes");
    expect((screen.getByRole("button", { name: "Install a library…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();
    show({ libraries: null });
    expect(screen.getByText("Reading what is installed…")).toBeTruthy();
  });
});
