import { Provider } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CloudOrgPanelHeader from "./CloudOrgPanelHeader";
import { CLOUD_ORG_MANAGEMENT_TAB } from "./cloudOrgPanelTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("CloudOrgPanelHeader", () => {
  it("shows only the localized General and Members tabs", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        null,
        createElement(CloudOrgPanelHeader, {
          orgId: "org-1",
          activeTab: CLOUD_ORG_MANAGEMENT_TAB.GENERAL,
          onTabChange: vi.fn(),
        })
      )
    );

    expect(markup).toContain('data-testid="cloud-org-tab-general"');
    expect(markup).toContain('data-testid="cloud-org-tab-members"');
    expect(markup).not.toContain('data-testid="cloud-org-tab-sessions"');
    expect(markup).not.toContain('data-testid="cloud-org-tab-repo-scope"');
    expect(markup.indexOf('data-testid="cloud-org-tab-general"')).toBeLessThan(
      markup.indexOf('data-testid="cloud-org-tab-members"')
    );
    expect(markup).toContain("sections.general");
    expect(markup).toContain("cloud.orgPanel.membersTitle");
  });
});
