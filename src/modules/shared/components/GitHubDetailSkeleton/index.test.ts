import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import GitHubDetailSkeleton from ".";

describe.each(["issue", "pr"] as const)(
  "GitHubDetailSkeleton %s loading state",
  (kind) => {
    it("keeps scrolling without rendering a decorative right rail", () => {
      const markup = renderToStaticMarkup(
        createElement(GitHubDetailSkeleton, { kind })
      );

      expect(markup).toContain("scrollbar-overlay");
      expect(markup).toContain("overflow-y-auto");
      expect(markup).not.toContain("border-l border-border-1");
      expect(markup).not.toContain("h-24 w-1 rounded-full");
    });
  }
);
