import { describe, expect, it } from "vitest";

import {
  PERSONAL_EXCLUDED_TOKEN,
  cloudOrgIdsForSession,
  cloudOrgToken,
  isSessionExcludedFromPersonal,
  isSessionTaggedToCloudOrg,
  taggedCloudOrgIds,
  withTag,
  withoutCloudOrgTag,
  withoutTag,
} from "./sessionOrgTagsAtom";

// Legacy token shape from the retired self-hosted track: a BARE org id
// (no `cloud:` prefix). Persisted localStorage state may still carry these.
const LEGACY_SELF_HOSTED_TOKEN = "h1";

describe("sessionOrgTagsAtom helpers", () => {
  it("namespaces cloud tokens", () => {
    expect(cloudOrgToken("o1")).toBe("cloud:o1");
  });

  it("skips unknown legacy tokens in persisted tags (tolerant parse)", () => {
    // A pre-Phase-E localStorage record mixing cloud and legacy self-hosted
    // tokens must keep parsing: the cloud helpers just ignore bare tokens.
    const tags = {
      s1: [cloudOrgToken("c1"), LEGACY_SELF_HOSTED_TOKEN, cloudOrgToken("c2")],
    };
    expect(cloudOrgIdsForSession(tags, "s1").sort()).toEqual(["c1", "c2"]);
    expect(cloudOrgIdsForSession(tags, "missing")).toEqual([]);
  });

  it("checks cloud membership without colliding with legacy tokens", () => {
    const tags = { s1: [cloudOrgToken("x"), "y"] };
    expect(isSessionTaggedToCloudOrg(tags, "s1", "x")).toBe(true);
    // "y" is a legacy bare token — never mistaken for the cloud org "y".
    expect(isSessionTaggedToCloudOrg(tags, "s1", "y")).toBe(false);
  });

  it("collects every cloud org id that has a tagged session", () => {
    const tags = {
      s1: [cloudOrgToken("c1")],
      s2: [cloudOrgToken("c1"), cloudOrgToken("c2"), LEGACY_SELF_HOSTED_TOKEN],
    };
    expect([...taggedCloudOrgIds(tags)].sort()).toEqual(["c1", "c2"]);
  });

  it("withTag is idempotent and immutable", () => {
    const base = {};
    const once = withTag(base, "s1", cloudOrgToken("c1"));
    expect(once).toEqual({ s1: ["cloud:c1"] });
    const twice = withTag(once, "s1", cloudOrgToken("c1"));
    expect(twice).toBe(once); // no-op returns same reference
    expect(base).toEqual({}); // original untouched
  });

  it("withoutTag drops the session key when the last tag is removed", () => {
    const tags = { s1: [cloudOrgToken("c1")], s2: [cloudOrgToken("c2")] };
    const next = withoutTag(tags, "s1", cloudOrgToken("c1"));
    expect(next).toEqual({ s2: ["cloud:c2"] });
    expect("s1" in next).toBe(false);
    // removing a tag that isn't present is a no-op
    expect(withoutTag(next, "s1", cloudOrgToken("c1"))).toBe(next);
  });

  it("personal exclusion is independent of cloud org tags", () => {
    expect(isSessionExcludedFromPersonal({}, "s1")).toBe(false);
    let tags = withTag({}, "s1", cloudOrgToken("c1"));
    tags = withTag(tags, "s1", PERSONAL_EXCLUDED_TOKEN);
    expect(isSessionExcludedFromPersonal(tags, "s1")).toBe(true);
    expect(cloudOrgIdsForSession(tags, "s1")).toEqual(["c1"]);
    expect(taggedCloudOrgIds(tags)).toEqual(new Set(["c1"]));
    tags = withoutTag(tags, "s1", PERSONAL_EXCLUDED_TOKEN);
    expect(isSessionExcludedFromPersonal(tags, "s1")).toBe(false);
    expect(cloudOrgIdsForSession(tags, "s1")).toEqual(["c1"]);
  });

  it("withoutCloudOrgTag keeps the personal exclusion while other cloud tags remain", () => {
    let tags = withTag({}, "s1", cloudOrgToken("c1"));
    tags = withTag(tags, "s1", cloudOrgToken("c2"));
    tags = withTag(tags, "s1", PERSONAL_EXCLUDED_TOKEN);
    const next = withoutCloudOrgTag(tags, "s1", "c1");
    expect(cloudOrgIdsForSession(next, "s1")).toEqual(["c2"]);
    expect(isSessionExcludedFromPersonal(next, "s1")).toBe(true);
  });

  it("withoutCloudOrgTag clears the personal exclusion with the last cloud tag", () => {
    let tags = withTag({}, "s1", cloudOrgToken("c1"));
    tags = withTag(tags, "s1", PERSONAL_EXCLUDED_TOKEN);
    const next = withoutCloudOrgTag(tags, "s1", "c1");
    expect(next).toEqual({});
    expect(isSessionExcludedFromPersonal(next, "s1")).toBe(false);
  });

  it("withoutCloudOrgTag ignores legacy tokens when deciding the last cloud tag", () => {
    let tags = withTag({}, "s1", cloudOrgToken("c1"));
    tags = withTag(tags, "s1", LEGACY_SELF_HOSTED_TOKEN);
    tags = withTag(tags, "s1", PERSONAL_EXCLUDED_TOKEN);
    const next = withoutCloudOrgTag(tags, "s1", "c1");
    expect(next).toEqual({ s1: [LEGACY_SELF_HOSTED_TOKEN] });
    expect(isSessionExcludedFromPersonal(next, "s1")).toBe(false);
  });

  it("withoutCloudOrgTag without a personal exclusion matches withoutTag", () => {
    const tags = { s1: [cloudOrgToken("c1")], s2: [cloudOrgToken("c2")] };
    expect(withoutCloudOrgTag(tags, "s1", "c1")).toEqual({
      s2: ["cloud:c2"],
    });
    expect(withoutCloudOrgTag(tags, "s1", "missing")).toBe(tags);
  });
});
