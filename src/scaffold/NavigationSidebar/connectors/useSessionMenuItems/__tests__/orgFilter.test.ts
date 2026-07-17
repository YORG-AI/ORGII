import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";

import {
  buildSessionOrgFilterIds,
  sessionMatchesOrgFilter,
} from "../orgFilter";

describe("buildSessionOrgFilterIds", () => {
  it("accepts the bare cloud org id under a cloud:<id> scope", () => {
    // Cloud imports/forks stamp Session.orgId with the BARE org id.
    const ids = buildSessionOrgFilterIds("cloud:cloud-org-9");
    expect(ids.has("cloud:cloud-org-9")).toBe(true);
    expect(ids.has("cloud-org-9")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("matches a cloud-stamped session under the cloud scope only", () => {
    const cloudIds = buildSessionOrgFilterIds("cloud:cloud-org-9");
    const personalIds = buildSessionOrgFilterIds(DEFAULT_SESSION_ORG_ID);
    expect(sessionMatchesOrgFilter({ orgId: "cloud-org-9" }, cloudIds)).toBe(
      true
    );
    expect(sessionMatchesOrgFilter({ orgId: "cloud-org-9" }, personalIds)).toBe(
      false
    );
    expect(sessionMatchesOrgFilter({ orgId: undefined }, cloudIds)).toBe(false);
  });

  it("stays strict for a plain local project org selection", () => {
    const ids = buildSessionOrgFilterIds("local-org-1");
    expect(Array.from(ids)).toEqual(["local-org-1"]);
  });

  it("returns just the personal id for the default selection", () => {
    const ids = buildSessionOrgFilterIds(DEFAULT_SESSION_ORG_ID);
    expect(Array.from(ids)).toEqual([DEFAULT_SESSION_ORG_ID]);
  });
});

describe("sessionMatchesOrgFilter", () => {
  it("keeps unstamped sessions (personal work, guest share-imports) under Personal", () => {
    const personalIds = buildSessionOrgFilterIds(DEFAULT_SESSION_ORG_ID);
    const cloudIds = buildSessionOrgFilterIds("cloud:cloud-org-9");
    // No orgId ⇒ visible under Personal, hidden under a cloud org scope.
    expect(sessionMatchesOrgFilter({ orgId: undefined }, personalIds)).toBe(
      true
    );
    expect(sessionMatchesOrgFilter({ orgId: undefined }, cloudIds)).toBe(false);
    // Org-stamped sessions leave the Personal scope.
    expect(sessionMatchesOrgFilter({ orgId: "cloud-org-9" }, personalIds)).toBe(
      false
    );
  });

  it("disables filtering when the accepted set is undefined or empty", () => {
    expect(sessionMatchesOrgFilter({ orgId: "cloud-org-9" }, undefined)).toBe(
      true
    );
    expect(sessionMatchesOrgFilter({ orgId: undefined }, new Set())).toBe(true);
  });
});
