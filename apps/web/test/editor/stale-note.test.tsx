// @vitest-environment jsdom
//
// The strip that says the host is behind its own source: there only when there is something to say.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { StaleNote } from "../../src/editor/StaleNote.js";

afterEach(cleanup);

describe("the stale note", () => {
  it("is not there at all when there is nothing to say", () => {
    const { container } = render(<StaleNote note={null} />);
    expect(container.textContent).toBe("");
  });

  it("says its piece, and can be sent away", async () => {
    const user = userEvent.setup();
    render(<StaleNote note="The host started before the last change to the code. Restart it." />);
    expect(screen.getByRole("status").textContent).toContain("Restart it");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("comes back for a different piece of news", async () => {
    const user = userEvent.setup();
    const view = render(<StaleNote note="The host started before the last change." />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<StaleNote note="The app has not been built since the last change to it." />);
    expect(screen.getByRole("status").textContent).toContain("not been built");
  });
});
