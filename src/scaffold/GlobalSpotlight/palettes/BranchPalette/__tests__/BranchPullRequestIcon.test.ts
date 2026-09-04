import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { getBranchPullRequestIcon } from "../BranchPullRequestIcon";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("PR status icons", () => {
  it.each([
    ["open", false, "open", "pull-request"],
    ["OPEN", true, "draft", "draft"],
    ["closed", true, "closed", "closed"],
    ["merged", true, "merged", "merge"],
    ["unknown", false, "unknown", "pull-request"],
  ])(
    "renders %s draft=%s as an accessible %s icon without status text",
    (state, draft, status, glyph) => {
      const markup = renderToStaticMarkup(
        createElement(getBranchPullRequestIcon({ state, draft }), { size: 16 })
      );
      expect(markup).toContain(`data-pr-status="${status}"`);
      expect(markup).toContain(`data-icon="pr-${glyph}"`);
      expect(markup).toContain(`aria-label="labels.prStatus.${status}"`);
      expect(markup).not.toMatch(/>[^<>]+</);
    }
  );
});
