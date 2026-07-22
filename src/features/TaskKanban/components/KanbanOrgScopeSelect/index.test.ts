import { Provider, createStore } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";

import KanbanOrgScopeSelect from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("KanbanOrgScopeSelect", () => {
  it("renders the globally selected organization in a ghost select", () => {
    const store = createStore();
    const selectedValue = buildCloudOrgSelectorValue("acme");
    store.set(org2CloudOrgsAtom, [
      { orgId: "acme", name: "Acme", role: "member" },
    ]);
    store.set(sidebarSelectedOrgIdAtom, selectedValue);

    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store },
        React.createElement(KanbanOrgScopeSelect)
      )
    );

    expect(markup).toContain('data-testid="kanban-org-scope-select"');
    expect(markup).toContain("select-ghost");
    expect(markup).toContain("Acme");
  });
});
