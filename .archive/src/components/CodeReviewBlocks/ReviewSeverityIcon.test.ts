import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReviewCommentSeverity } from "@src/api/http/project";

import ReviewSeverityIcon from "./ReviewSeverityIcon";

const REVIEW_SEVERITY_CASES: Array<{
  severity: ReviewCommentSeverity;
  iconClass: string;
  colorClass: string;
}> = [
  {
    severity: "error",
    iconClass: 'data-icon="xcircle"',
    colorClass: "text-danger-6",
  },
  {
    severity: "warning",
    iconClass: 'data-icon="alert-triangle"',
    colorClass: "text-warning-6",
  },
  {
    severity: "suggestion",
    iconClass: 'data-icon="lightbulb"',
    colorClass: "text-primary-6",
  },
  {
    severity: "praise",
    iconClass: 'data-icon="thumbs-up"',
    colorClass: "text-success-6",
  },
];

describe("ReviewSeverityIcon", () => {
  it.each(REVIEW_SEVERITY_CASES)(
    "preserves the $severity icon and color mapping",
    ({ severity, iconClass, colorClass }) => {
      const markup = renderToStaticMarkup(
        createElement(ReviewSeverityIcon, {
          severity,
          size: 17,
          className: "review-severity-test",
        })
      );

      expect(markup).toContain(iconClass);
      expect(markup).toContain(colorClass);
      expect(markup).toContain('width="17"');
      expect(markup).toContain('height="17"');
      expect(markup).toContain("shrink-0");
      expect(markup).toContain("review-severity-test");
    }
  );
});
