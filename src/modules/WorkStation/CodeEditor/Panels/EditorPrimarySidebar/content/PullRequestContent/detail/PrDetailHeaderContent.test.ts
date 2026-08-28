// @vitest-environment jsdom
import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { PrDetailHeaderContent } from "./PrDetailHeaderContent";

vi.mock("@src/modules/shared/components/GitHubDetailHeaderContent", () => ({
  default: ({
    number,
    status,
    title,
  }: {
    number: number;
    status: ReactNode;
    title: string;
  }) => createElement("div", null, status, `#${number}`, title),
}));

function renderStatus(status: string): HTMLElement {
  const identity: PrIdentity = {
    number: 42,
    title: "Status presentation",
    url: "https://github.com/org/repo/pull/42",
    status,
    headBranch: "feature/status",
    baseBranch: "main",
  };
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(PrDetailHeaderContent, { identity })
  );
  const statusElement = container.querySelector<HTMLElement>(
    "[data-testid='pr-detail-status']"
  );
  if (!statusElement) throw new Error("Expected PR status element");
  return statusElement;
}

describe("PrDetailHeaderContent", () => {
  it("renders draft as a neutral icon without text or a tag", () => {
    const status = renderStatus("draft");

    expect(status.className).toContain("text-text-2");
    expect(status.className).not.toContain("rounded-full");
    expect(status.className).not.toContain("px-2");
    expect(
      status.querySelector('[data-icon="git-pull-request-draft"]')
    ).not.toBeNull();
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-label")).toBe("draft");
  });

  it("uses semantic icons and colors for merged and closed states", () => {
    const merged = renderStatus("merged");
    const closed = renderStatus("closed");

    expect(merged.className).toContain("text-purple-6");
    expect(merged.querySelector('[data-icon="git-merge"]')).not.toBeNull();
    expect(closed.className).toContain("text-danger-6");
    expect(
      closed.querySelector('[data-icon="git-pull-request-closed"]')
    ).not.toBeNull();
    expect(merged.textContent).toBe("");
    expect(closed.textContent).toBe("");
  });
});
