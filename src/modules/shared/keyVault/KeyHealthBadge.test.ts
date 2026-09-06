import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import KeyHealthBadge from "./KeyHealthBadge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { count?: number; message?: string }
    ): string => {
      switch (key) {
        case "keyVault.health.invalidKeyMessage":
          return "Invalid key";
        case "keyVault.health.failuresDetected":
          return `${options?.count} failures detected`;
        case "keyVault.health.errorWithMessage":
          return `Error: ${options?.message}`;
        case "keyVault.quickActions.valid":
          return "Valid";
        default:
          return key;
      }
    },
  }),
}));

describe("KeyHealthBadge", () => {
  it("keeps the failure count in the alert title beside the headline", () => {
    const markup = renderToStaticMarkup(
      createElement(KeyHealthBadge, {
        healthStatus: "invalid",
        failureCount: 8,
        lastFailureMessage: "refresh_token_invalidated",
      })
    );

    expect(markup).toContain(">Invalid key · 8 failures detected</span>");
    expect(markup).toContain(
      '<p class="text-xs wrap-break-word">Error: refresh_token_invalidated</p>'
    );
    expect(markup.indexOf('data-icon="triangle-alert"')).toBeLessThan(
      markup.indexOf(">Invalid key · 8 failures detected</span>")
    );
  });
});
