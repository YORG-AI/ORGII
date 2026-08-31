// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionListItem } from "./SessionListItem";

function renderRow(status: "running" | "idle" = "idle"): HTMLButtonElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(SessionListItem, {
      name: "A very long session title that must remain inside its own row",
      status,
    })
  );
  const row = host.querySelector<HTMLButtonElement>(
    "[data-testid=mobile-remote-session-row]"
  );
  if (!row) throw new Error("Session row did not render");
  return row;
}

describe("SessionListItem layout", () => {
  it("keeps the icon and text as direct flex children of the row", () => {
    const row = renderRow();

    expect(row.tagName).toBe("BUTTON");
    expect(row.className).toContain("flex");
    expect(row.className).toContain("w-full");
    expect(row.children).toHaveLength(2);
    expect(row.children[0]?.className).toContain("shrink-0");
    expect(row.children[1]?.className).toContain("min-w-0");
    expect(row.children[1]?.querySelector(".truncate")?.textContent).toContain(
      "A very long session title"
    );
  });

  it("adds the live badge as a third sibling without wrapping the row content", () => {
    const row = renderRow("running");

    expect(row.children).toHaveLength(3);
    expect(row.textContent).toContain("LIVE");
  });
});
