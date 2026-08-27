import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";

import StatusDot, { type StatusDotProps } from "./index";

function renderStatusDot(props: StatusDotProps): string {
  return renderToStaticMarkup(React.createElement(StatusDot, props));
}

describe("StatusDot", () => {
  it("renders the default table-sized status with its label, count, and accessible name", () => {
    const markup = renderStatusDot({
      color: "bg-success-6",
      label: "Connected",
      count: 3,
      ariaLabel: "Connection status",
    });

    expect(markup).toContain('aria-label="Connection status"');
    expect(markup).toContain("bg-success-6");
    expect(markup).toContain(
      `<span class="${SETTINGS_TABLE_CELL.value}">Connected</span>`
    );
    expect(markup).toContain('<span class="text-text-4">·</span>');
    expect(markup).toContain(`tabular-nums ${SETTINGS_TABLE_CELL.value}`);
    expect(markup).toContain(">3</span>");
  });

  it("applies the requested inline and dense-list label sizing", () => {
    const inlineMarkup = renderStatusDot({
      color: "bg-warning-6",
      label: "Connecting",
      size: "inline",
      labelClassName: "custom-label",
    });
    const denseMarkup = renderStatusDot({
      color: "bg-danger-6",
      label: "Offline",
      size: "sm",
    });

    expect(inlineMarkup).toContain(
      '<span class="custom-label">Connecting</span>'
    );
    expect(denseMarkup).toContain(
      '<span class="text-xs text-text-2">Offline</span>'
    );
  });

  it("pulses only when requested and can render a count without a label", () => {
    const markup = renderStatusDot({
      color: "bg-primary-6",
      pulse: true,
      count: 1,
    });

    expect(markup).toContain("bg-primary-6 animate-pulse");
    expect(markup).not.toContain(`${SETTINGS_TABLE_CELL.value}"></span>`);
    expect(markup).toContain(">1</span>");
  });
});
