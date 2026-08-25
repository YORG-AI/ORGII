import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import MarkdownLinkIcon, {
  hasMarkdownLinkIcon,
  isGitHubMarkdownHref,
} from "./MarkdownLinkIcon";
import type { MarkdownLinkTarget } from "./markdownLinkTarget";

vi.mock("@src/assets/channelIcons/github.svg", () => ({
  default: () => createElement("svg", { "data-link-icon": "github" }),
}));

vi.mock("@src/components/FileTypeIcon", () => ({
  default: ({ fileName }: { fileName: string }) =>
    createElement("svg", {
      "data-file-name": fileName,
      "data-link-icon": "file",
    }),
}));

function renderIcon(href: string, target: MarkdownLinkTarget): string {
  return renderToStaticMarkup(
    createElement(MarkdownLinkIcon, { href, target })
  );
}

describe("MarkdownLinkIcon", () => {
  it.each([
    "https://github.com/org2AI/ORG2",
    "https://www.github.com/org2AI/ORG2/pull/959",
    "http://github.com/org2AI/ORG2/issues/1",
  ])("renders the GitHub SVG for an exact GitHub host: %s", (href) => {
    const markup = renderIcon(href, { kind: "browser", url: href });

    expect(markup).toContain('data-link-icon="github"');
    expect(markup).not.toContain('data-link-icon="file"');
  });

  it("renders the matching file icon without the source line suffix", () => {
    const markup = renderIcon("src/i18n/navigation.json:42", {
      kind: "local",
      path: "/repo/src/i18n/navigation.json:42",
    });

    expect(markup).toContain('data-link-icon="file"');
    expect(markup).toContain('data-file-name="/repo/src/i18n/navigation.json"');
  });

  it("leaves ordinary web links without a leading icon", () => {
    const href = "https://example.com/docs";
    const target = { kind: "browser", url: href } as const;

    expect(renderIcon(href, target)).toBe("");
    expect(hasMarkdownLinkIcon(href, target)).toBe(false);
  });

  it("reports icons for both GitHub and local-file links", () => {
    const githubHref = "https://github.com/org/repo";

    expect(
      hasMarkdownLinkIcon(githubHref, {
        kind: "browser",
        url: githubHref,
      })
    ).toBe(true);
    expect(
      hasMarkdownLinkIcon("navigation.json", {
        kind: "local",
        path: "/repo/navigation.json",
      })
    ).toBe(true);
  });

  it("does not treat lookalike or non-web GitHub URLs as GitHub links", () => {
    expect(isGitHubMarkdownHref("https://github.com.example.com/repo")).toBe(
      false
    );
    expect(isGitHubMarkdownHref("mailto:hello@github.com")).toBe(false);
    expect(isGitHubMarkdownHref("github.com/org/repo")).toBe(false);
  });
});
