import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SessionCreatorAgentHero from "./SessionCreatorAgentHero";

const chatPanelStyles = readFileSync(resolve(__dirname, "index.scss"), "utf8");

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
    expect(markup.match(/hidden @\[640px\]\/focusedchat:inline/g)).toHaveLength(
      2
    );
    expect(markup).toContain("?</span>");
    expect(markup).toContain("A very long Ghost agent name");
    expect(markup).not.toContain(
      "This description is intentionally hidden in Launchpad"
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("bg-transparent!");
    expect(markup).toContain("p-2!");
    expect(markup).toContain("font-normal!");
    expect(markup).toContain("font-bold!");
    expect(markup).toContain("text-text-1!");
    expect(markup).toContain("underline underline-offset-4");
    expect(markup).not.toContain("group-hover/pill:text-primary-6!");
    expect(markup).toContain('data-icon="chevron-up"');
    expect(markup).toContain("whitespace-normal");
    expect(markup).not.toContain("truncate");
  });

  it("keeps the hero pill on its own compositor layer", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionCreatorAgentHero, {
        name: "SDE Agent",
        description: "Software development agent",
        avatarIcon: createElement("span", null, "SDE"),
        question: "What do you want to build with",
        questionSuffix: "?",
        onClick: vi.fn(),
      })
    );

    // The launchpad block is positioned on a fractional device pixel, so a
    // `transition-colors` repaint would otherwise re-round the avatar glyph.
    expect(markup).toContain("transform-gpu");
  });

  it("does not underline the Launchpad agent name on hover", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionCreatorAgentHero, {
        name: "SDE Agent",
        description: "Software development agent",
        avatarIcon: createElement("span", null, "SDE"),
        question: "What do you want to build with",
        questionSuffix: "?",
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain("group-hover/pill:text-text-1!");
    expect(markup).not.toContain("group-hover/pill:underline");
  });

  it("moves the launchpad title and cards together to the top-left in short windows", () => {
    const shortWindowStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf("@media (max-height: 800px)"),
      chatPanelStyles.indexOf("@media (max-height: 600px)")
    );

    expect(shortWindowStyles).toMatch(
      /\.session-creator-chat-panel-launchpad-content\s*\{[\s\S]*?justify-content:\s*flex-start;/
    );
    expect(shortWindowStyles).toMatch(
      /\.session-creator-chat-panel-launchpad-middle\s*\{[\s\S]*?align-items:\s*flex-start;[\s\S]*?translate:\s*none;/
    );
    expect(shortWindowStyles).toMatch(
      /\.session-creator-chat-panel-launchpad-suggestions > \*\s*\{[\s\S]*?margin-inline:\s*8px 0;/
    );
  });

  it("keeps the same top-left title position in the smallest compact state", () => {
    const compactWindowStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf("@media (max-height: 600px)"),
      chatPanelStyles.indexOf("&.session-creator-chat-panel-centered-composer")
    );

    expect(compactWindowStyles).not.toContain("padding-top:");
    expect(compactWindowStyles).toContain(
      "@include launchpad-action-grid-compact-state"
    );
  });

  it("keeps the card disclosure visible when the chat panel is narrow", () => {
    const compactStateStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf("@mixin launchpad-action-grid-compact-state"),
      chatPanelStyles.indexOf(".session-creator-chat-panel-wrapper")
    );

    expect(chatPanelStyles).toMatch(
      /@container focusedchat \(max-width: 639px\)\s*\{\s*@include launchpad-action-grid-compact-state;/
    );
    expect(compactStateStyles).toContain(
      '&[data-compact-expanded="false"] .launchpad-action-grid-content'
    );
    expect(compactStateStyles).toMatch(
      /\.launchpad-action-grid-compact-toggle\s*\{[\s\S]*?display:\s*flex;/
    );
  });
});
