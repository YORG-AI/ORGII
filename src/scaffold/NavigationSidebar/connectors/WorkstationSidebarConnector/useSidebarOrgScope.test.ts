import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";

import { resolveSidebarOrgSelection } from "./useSidebarOrgScope";

const PERSONAL_OPTION = [{ value: DEFAULT_SESSION_ORG_ID }];

describe("resolveSidebarOrgSelection", () => {
  it("keeps an unresolved cloud selection visible as loading", () => {
    expect(
      resolveSidebarOrgSelection({
        selectedOrgId: "cloud:org-1",
        options: PERSONAL_OPTION,
        cloudAuthed: true,
        cloudOrgsLoaded: false,
        projectOrgsLoaded: true,
      })
    ).toEqual({ activeOrgId: "cloud:org-1", loading: true });
  });

  it("keeps an unresolved local selection visible as loading", () => {
    expect(
      resolveSidebarOrgSelection({
        selectedOrgId: "local-org-1",
        options: PERSONAL_OPTION,
        cloudAuthed: false,
        cloudOrgsLoaded: false,
        projectOrgsLoaded: false,
      })
    ).toEqual({ activeOrgId: "local-org-1", loading: true });
  });

  it("uses the local personal profile when the selection is empty", () => {
    expect(
      resolveSidebarOrgSelection({
        selectedOrgId: "",
        options: PERSONAL_OPTION,
        cloudAuthed: false,
        cloudOrgsLoaded: false,
        projectOrgsLoaded: false,
      })
    ).toEqual({ activeOrgId: DEFAULT_SESSION_ORG_ID, loading: false });
  });

  it("falls back to the local personal profile after a missing scope loads", () => {
    expect(
      resolveSidebarOrgSelection({
        selectedOrgId: "cloud:missing",
        options: PERSONAL_OPTION,
        cloudAuthed: true,
        cloudOrgsLoaded: true,
        projectOrgsLoaded: true,
      })
    ).toEqual({ activeOrgId: DEFAULT_SESSION_ORG_ID, loading: false });
  });
});
