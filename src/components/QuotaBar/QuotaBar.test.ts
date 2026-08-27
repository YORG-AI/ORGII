import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import QuotaBar, {
  QuotaBarInline,
  type QuotaBarProps,
  QuotaStatusBar,
  getQuotaBgColorClass,
  getQuotaTextColorClass,
} from "./index";

function renderQuotaBar(props: QuotaBarProps): string {
  return renderToStaticMarkup(React.createElement(QuotaBar, props));
}

describe("QuotaBar", () => {
  it("uses danger, warning, and success treatments at the remaining-quota thresholds", () => {
    expect(getQuotaTextColorClass(9)).toBe("text-danger-6");
    expect(getQuotaTextColorClass(10)).toBe("text-warning-6");
    expect(getQuotaTextColorClass(30)).toBe("text-success-6");
    expect(getQuotaBgColorClass(9)).toBe("bg-danger-6");
    expect(getQuotaBgColorClass(10)).toBe("bg-warning-6");
    expect(getQuotaBgColorClass(30)).toBe("bg-success-6");
  });

  it("clamps compact quota values before rendering the text and bar", () => {
    const aboveMaximum = renderQuotaBar({
      remainingPercent: 125,
      label: "Daily quota",
      showUsedPercent: true,
      planType: "Pro",
    });
    const belowMinimum = renderQuotaBar({ remainingPercent: -5 });

    expect(aboveMaximum).toContain("100% left");
    expect(aboveMaximum).toContain('style="width:100%"');
    expect(aboveMaximum).not.toContain("% used");
    expect(aboveMaximum).toContain("Plan: Pro");
    expect(belowMinimum).toContain("0% left");
    expect(belowMinimum).toContain('style="width:0%"');
    expect(belowMinimum).toContain("bg-danger-6");
  });

  it("renders the inline variant's unlimited state without a percentage", () => {
    const markup = renderQuotaBar({
      remainingPercent: 12,
      variant: "inline",
      isUnlimited: true,
    });

    expect(markup).toContain(">∞</span>");
    expect(markup).not.toContain("% left");
  });

  it("renders the full variant's fallback label, formatted values, and used percentage", () => {
    const markup = renderQuotaBar({
      remainingPercent: 63.4,
      variant: "full",
      used: 37,
      limit: 100,
      formatValue: (value) => `${value} tokens`,
      showUsedPercent: true,
    });

    expect(markup).toContain("Quota Usage");
    expect(markup).toContain("37 tokens / 100 tokens");
    expect(markup).toContain("63% left");
    expect(markup).toContain("37% used");
    expect(markup).toContain('style="width:63.4%"');
  });
});

describe("QuotaBarInline", () => {
  it("switches between text-only and bar presentations", () => {
    const textOnly = renderToStaticMarkup(
      React.createElement(QuotaBarInline, { remainingPercent: 18 })
    );
    const withBar = renderToStaticMarkup(
      React.createElement(QuotaBarInline, {
        remainingPercent: 18,
        showBar: true,
      })
    );

    expect(textOnly).toContain("18% left");
    expect(withBar).toContain('style="width:18%"');
    expect(withBar).toContain(">18%</span>");
    expect(withBar).not.toContain("% left");
  });
});

describe("QuotaStatusBar", () => {
  it("shows login and plan status alongside an unlimited quota bar", () => {
    const markup = renderToStaticMarkup(
      React.createElement(QuotaStatusBar, {
        remainingPercent: 42,
        isUnlimited: true,
        planType: "Enterprise",
      })
    );

    expect(markup).toContain("Logged in");
    expect(markup).toContain("Quota:");
    expect(markup).toContain("Enterprise");
    expect(markup).toContain(">∞</span>");
    expect(markup).toContain('style="width:100%"');
  });
});
