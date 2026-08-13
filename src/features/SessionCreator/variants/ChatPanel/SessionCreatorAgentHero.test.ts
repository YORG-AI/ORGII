import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SessionCreatorAgentHero from "./SessionCreatorAgentHero";

describe("SessionCreatorAgentHero", () => {
  it("renders the Launchpad agent as icon, bold name, and trailing chevron", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionCreatorAgentHero, {
        name: "A very long Ghost agent name",
        description: "This description is intentionally hidden in Launchpad",
        avatarIcon: createElement("span", null, "Ghost"),
        question: "What do you want to build with",
        questionSuffix: "?",
        active: true,
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain("What do you want to build with");
    expect(markup).toContain("hidden @[640px]/focusedchat:inline");
    expect(markup).toContain("?</span>");
    expect(markup).toContain("A very long Ghost agent name");
    expect(markup).not.toContain(
      "This description is intentionally hidden in Launchpad"
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("!bg-transparent");
    expect(markup).toContain("!p-2");
    expect(markup).toContain("!font-normal");
    expect(markup).toContain("!font-bold");
    expect(markup).toContain("!text-text-1");
    expect(markup).toContain("group-hover/pill:!text-primary-6");
    expect(markup).toContain("group-hover/pill:underline");
    expect(markup).toContain("lucide-chevron-up");
    expect(markup).toContain("whitespace-normal");
    expect(markup).not.toContain("truncate");
  });
});
