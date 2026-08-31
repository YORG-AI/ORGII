// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionListItem } from "./SessionListItem";

function renderRow(status: "running" | "idle" = "idle"): HTMLButtonElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(SessionListItem, {
      sessionId: "sdeagent-thread-1",
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
  it("reuses the compact Desktop sidebar row geometry and typography", () => {
    const row = renderRow();

    expect(row.tagName).toBe("BUTTON");
    expect(row.className).toContain("flex");
    expect(row.className).toContain("h-8");
    expect(row.className).toContain("w-full");
    expect(row.children).toHaveLength(1);
    expect(row.querySelector("[data-icon=session-sdeagent-thread-1]")).not.toBe(
      null
    );
    expect(row.querySelector(".text-\\[13px\\]")?.textContent).toContain(
      "A very long session title"
    );
    expect(row.textContent).not.toContain("idle");
    expect(row.textContent).not.toContain("LIVE");
  });

  it("shows the same compact working status dot used by Desktop rows", () => {
    const row = renderRow("running");

    expect(row.querySelector('[aria-label="Working"]')).not.toBe(null);
    expect(row.textContent).not.toContain("running");
  });
});
