import { Provider } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OrganizationPanelHeader from "./OrganizationPanelHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("OrganizationPanelHeader", () => {
  it("uses the Launchpad-aligned pinned header without a published header row", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        null,
        React.createElement(OrganizationPanelHeader, {
          organization: {
            kind: "local",
            projectOrg: {
              orgId: "personal-org",
              orgName: "My Personal Org",
              orgScope: "personal_org",
            },
          },
          dataTestId: "local-org-management-header",
          tabControl: React.createElement(
            "span",
            { "data-testid": "organization-tabs" },
            "Tabs"
          ),
        })
      )
    );

    expect(markup).toContain('data-testid="local-org-management-header"');
    expect(markup).toContain("sticky top-0");
    expect(markup).toContain("h-14");
    expect(markup).toContain("-translate-y-1");
    expect(markup).toContain('data-testid="organization-tabs"');
    expect(markup).toContain('data-testid="organization-picker-separator"');
    expect(markup).toContain('data-testid="organization-picker"');
    expect(markup).toContain("orgs.personalOrg");
    expect(markup.indexOf('data-testid="organization-picker"')).toBeLessThan(
      markup.indexOf('data-testid="organization-tabs"')
    );
    expect(markup).not.toContain("chat-panel-published-header");
  });
});
