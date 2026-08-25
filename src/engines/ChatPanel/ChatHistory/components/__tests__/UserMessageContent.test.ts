import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import UserMessageContent, {
  normalizeMarkdownReferencePills,
  parseUserMessage,
} from "../UserMessageContent";

describe("external-history Markdown URL pills", () => {
  it("normalizes a self-labelled GitHub issue link to the native issue pill", () => {
    const url = "https://github.com/org2AI/ORG2/issues/556";

    expect(normalizeMarkdownReferencePills(`[${url}](${url})`)).toBe(
      `org2AI/ORG2#556 [issue:${url}]`
    );
    expect(parseUserMessage(`[${url}](${url})`)).toEqual([
      {
        kind: "pill",
        displayName: "org2AI/ORG2#556",
        pillType: "issue",
        path: url,
        terminalText: undefined,
      },
    ]);
  });

  it("normalizes a generic self-labelled HTTP link to the native link pill", () => {
    const url = "https://example.com/docs/getting-started?view=full#install";

    expect(normalizeMarkdownReferencePills(`Open [${url}](${url}) next.`)).toBe(
      `Open example.com/docs/getting-started?view=full#install [link:${url}] next.`
    );
  });

  it("normalizes labelled web, file, folder, and session references", () => {
    expect(
      normalizeMarkdownReferencePills(
        "[Issue 556](https://github.com/org2AI/ORG2/issues/556)"
      )
    ).toBe("org2AI/ORG2#556 [issue:https://github.com/org2AI/ORG2/issues/556]");
    expect(
      normalizeMarkdownReferencePills(
        "[some file.ts](file:///repo/some%20file.ts)"
      )
    ).toBe("some-file.ts [file:/repo/some file.ts]");
    expect(normalizeMarkdownReferencePills("[fixtures](/repo/fixtures/)")).toBe(
      "fixtures [folder:/repo/fixtures/]"
    );
    expect(
      normalizeMarkdownReferencePills(
        "[Previous session](session://sdeagent-abc/42)"
      )
    ).toBe("Previous-session [session:sdeagent-abc]");
  });

  it("converts a generated external attachment envelope before parsing", () => {
    expect(
      parseUserMessage(
        [
          "# Files mentioned by the user:",
          "",
          "## report.pdf: /tmp/report.pdf",
          "",
          "## My request for Codex:",
          "Review it.",
        ].join("\n")
      )
    ).toEqual([
      {
        kind: "pill",
        displayName: "report.pdf",
        pillType: "file",
        path: "/tmp/report.pdf",
        terminalText: undefined,
      },
      { kind: "text", text: "\n\nReview it." },
    ]);
  });

  it("leaves images, escaped Markdown, and unsafe URLs alone", () => {
    const image = "![https://example.com/a.png](https://example.com/a.png)";
    const escaped = String.raw`\[https://example.com](https://example.com)`;
    const credentialed =
      "[https://user:secret@example.com](https://user:secret@example.com)";

    expect(normalizeMarkdownReferencePills(image)).toBe(image);
    expect(normalizeMarkdownReferencePills(escaped)).toBe(escaped);
    expect(normalizeMarkdownReferencePills(credentialed)).toBe(credentialed);
  });
});

describe("message reference interactions", () => {
  it("renders file references as ordinary links", () => {
    const markup = renderToStaticMarkup(
      createElement(UserMessageContent, {
        text: "fixtures [folder:/tmp/fixtures]",
      })
    );

    expect(markup).toContain("hover:underline");
    expect(markup).toContain("active:underline");
    expect(markup).toContain("focus-visible:underline");
    expect(markup).toContain('href="/tmp/fixtures"');
    expect(markup).not.toContain("rounded-md");
  });

  it("renders non-web references as links instead of special tags", () => {
    const markup = renderToStaticMarkup(
      createElement(UserMessageContent, { text: "main [branch:main]" })
    );

    expect(markup).toContain('href="main"');
    expect(markup).toContain("hover:underline");
    expect(markup).not.toContain("rounded-md");
  });

  it("renders an embedded PR reference as its real GitHub link", () => {
    const url = "https://github.com/org2AI/ORG2/pull/606";
    const encoded = btoa(
      encodeURIComponent(JSON.stringify({ prUrl: url, prNumber: 606 }))
    );
    const markup = renderToStaticMarkup(
      createElement(UserMessageContent, {
        text: `ORG2#606 [pr:pr://606::${encoded}]`,
      })
    );

    expect(markup).toContain(`href="${url}"`);
    expect(markup).not.toContain("rounded-md");
  });

  it("renders an unsafe serialized reference as plain text", () => {
    const markup = renderToStaticMarkup(
      createElement(UserMessageContent, {
        text: "bad [link:javascript:alert(1)]",
      })
    );

    expect(markup).toContain(">bad</span>");
    expect(markup).not.toContain("javascript:alert(1)");
  });
});

describe("Canvas Design component pills", () => {
  it("decodes the versioned preview context for sent-message rendering", () => {
    const jsonText = JSON.stringify({
      schemaVersion: 1,
      origin: "canvas-design",
      previewHtml: "<div>Stat</div>",
    });
    const encoded = btoa(encodeURIComponent(jsonText));

    expect(
      parseUserMessage(
        `Stat [dom-component:paste://canvas-design/event-a/1::${encoded}]\n字体变大一些`
      )
    ).toEqual([
      {
        kind: "pill",
        displayName: "Stat",
        pillType: "dom-component",
        path: "paste://canvas-design/event-a/1",
        terminalText: jsonText,
      },
      { kind: "text", text: "\n字体变大一些" },
    ]);
  });
});
