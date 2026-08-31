import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MessageFooter from ".";

describe("MessageFooter", () => {
  it("renders a semantic timestamp and an icon-only hover copy action", () => {
    const markup = renderToStaticMarkup(
      createElement(MessageFooter, {
        getCopyContent: () => "Completed response",
        timestamp: "2026-07-15T06:45:00.000Z",
        timestampLabel: "14:45",
        copyLabel: "Copy",
        copiedLabel: "Copied",
        copyFailedLabel: "Copy failed",
      })
    );

    expect(markup).toContain('data-testid="message-footer"');
    expect(markup).toContain('<time dateTime="2026-07-15T06:45:00.000Z"');
    expect(markup).toContain("14:45");
    expect(markup).toContain('data-testid="message-footer-copy"');
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain("group-hover/agent-message:opacity-100");
    expect(markup).not.toContain(">Copy</span>");
  });

  it("does not render without copyable content or timestamp text", () => {
    const markup = renderToStaticMarkup(
      createElement(MessageFooter, {
        timestamp: "",
        timestampLabel: "",
        copyLabel: "Copy",
        copiedLabel: "Copied",
        copyFailedLabel: "Copy failed",
      })
    );

    expect(markup).toBe("");
  });
});
