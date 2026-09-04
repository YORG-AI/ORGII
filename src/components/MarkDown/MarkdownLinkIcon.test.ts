import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SIZE_STYLES } from "@src/components/FileTypeIcon/types";

import MarkdownLinkIcon, {
  hasMarkdownLinkIcon,
  isGitHubMarkdownHref,
} from "./MarkdownLinkIcon";
import type { MarkdownLinkTarget } from "./markdownLinkTarget";

vi.mock("@src/assets/channelIcons/github.svg", () => ({
  default: ({ width, height }: { width?: number; height?: number }) =>
    createElement("svg", {
      "data-link-icon": "github",
      "data-box": `${width}x${height}`,
    }),
}));

vi.mock("@src/components/FileTypeIcon", () => ({
  default: ({ fileName, size }: { fileName: string; size?: string }) =>
    createElement("svg", {
      "data-file-name": fileName,
      "data-link-icon": "file",
      "data-size": size,
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

describe("MarkdownLinkIcon sizing", () => {
  const githubHref = "https://github.com/org2AI/ORG2";
  const localTarget: MarkdownLinkTarget = {
    kind: "local",
    path: "/repo/src/components/AttachPanel/index.tsx",
  };

  it("gives both link-icon variants the same intrinsic fallback box", () => {
    const github = renderIcon(githubHref, {
      kind: "browser",
      url: githubHref,
    });
    const file = renderIcon(
      "src/components/AttachPanel/index.tsx",
      localTarget
    );

    const fileSize = file.match(/data-size="(\w+)"/)?.[1] as
      | keyof typeof SIZE_STYLES
      | undefined;

    expect(fileSize).toBeDefined();
    const { width, height } = SIZE_STYLES[fileSize!];
    expect(github).toContain(`data-box="${width}x${height}"`);
  });

  it("renders the optically dense GitHub mark smaller than file artwork", () => {
    const github = renderIcon(githubHref, {
      kind: "browser",
      url: githubHref,
    });
    expect(github).toContain("markdown-link-icon-github");

    const styles = readFileSync(
      resolve(__dirname, "_base-elements.scss"),
      "utf8"
    );
    const githubRule = styles.match(
      /\.chat-markdown-body \.markdown-link-icon-github svg \{([\s\S]*?)\n\}/
    )?.[1];

    expect(githubRule).toMatch(/width: 1em/);
    expect(githubRule).toMatch(/height: 1em/);
  });

  it("sizes the rendered icon in em so it tracks the chat font size", () => {
    const styles = readFileSync(
      resolve(__dirname, "_base-elements.scss"),
      "utf8"
    );
    const rule = styles.match(
      /\.chat-markdown-body \.markdown-link-icon svg \{([\s\S]*?)\n\}/
    )?.[1];

    expect(rule).toMatch(/width: [\d.]+em/);
    expect(rule).toMatch(/height: [\d.]+em/);
    expect(rule).not.toMatch(/\dpx/);
  });

  it("offsets the taller icon box in em rather than a fixed pixel nudge", () => {
    const styles = readFileSync(
      resolve(__dirname, "_base-elements.scss"),
      "utf8"
    );
    const rule = styles.match(
      /\.chat-markdown-body \.markdown-link-icon \{([\s\S]*?)\n\}/
    )?.[1];

    expect(rule).toMatch(/vertical-align: -[\d.]+em/);
  });
});
