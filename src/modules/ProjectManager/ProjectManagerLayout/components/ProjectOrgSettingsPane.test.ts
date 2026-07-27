import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectOrg } from "@src/api/http/project";

import { OrgDangerZone } from "./ProjectOrgSettingsPane";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { org?: string }) =>
      values?.org ? `${key}:${values.org}` : key,
  }),
}));

function projectOrg(id: string): ProjectOrg {
  return {
    id,
    name: id === "personal-org" ? "My Personal Org" : "Local Team",
    slug: id,
    org_key: "ORG",
    source: "local",
    sync_provider: "none",
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
  };
}

describe("OrgDangerZone", () => {
  it("keeps the danger zone visible but disables deletion for personal org", () => {
    const markup = renderToStaticMarkup(
      React.createElement(OrgDangerZone, {
        org: projectOrg("personal-org"),
        onDeleteOrg: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="local-org-danger-zone"');
    expect(markup).toContain("personalOrgDeleteDisabled");
    expect(markup).toMatch(
      /disabled=""[^>]*data-testid="local-org-delete-confirm-input"/
    );
    expect(markup).toMatch(
      /disabled=""[^>]*data-testid="local-org-delete-confirm"/
    );
  });

  it("enables the confirmation input for a non-default local org", () => {
    const markup = renderToStaticMarkup(
      React.createElement(OrgDangerZone, {
        org: projectOrg("local-team"),
        onDeleteOrg: vi.fn(),
      })
    );

    expect(markup).toContain("deleteOrgDescription:Local Team");
    expect(markup).toContain("flex min-w-0 items-center gap-2 w-full");
    expect(markup).toContain("min-w-0 flex-1");
    expect(markup).not.toMatch(
      /disabled=""[^>]*data-testid="local-org-delete-confirm-input"/
    );
  });
});
