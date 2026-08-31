// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { storePillText } from "@src/config/pillTokens";

import {
  isSafePostedReferenceHref,
  resolvePostedReferenceHref,
} from "../postedReferenceHref";

describe("resolvePostedReferenceHref", () => {
  afterEach(() => {
    window.__orgiiTerminalPillTexts = {};
  });

  it("uses the cached GitHub URL behind a PR identity token", () => {
    storePillText(
      "pr://606",
      JSON.stringify({
        prNumber: 606,
        prTitle: "Remove reference tags",
        prUrl: "https://github.com/org2AI/ORG2/pull/606",
      })
    );

    expect(resolvePostedReferenceHref("pr://606", "pr")).toBe(
      "https://github.com/org2AI/ORG2/pull/606"
    );
  });

  it("uses durable embedded context when the in-memory cache is empty", () => {
    const payload = JSON.stringify({
      issueUrl: "https://github.com/org2AI/ORG2/issues/760",
    });
    const encoded = btoa(encodeURIComponent(payload));

    expect(resolvePostedReferenceHref(`issue://760::${encoded}`, "issue")).toBe(
      "https://github.com/org2AI/ORG2/issues/760"
    );
  });

  it("recovers the URL carried by a browser reference", () => {
    expect(
      resolvePostedReferenceHref(
        "browser://https://example.com/docs/1700000000000",
        "browser"
      )
    ).toBe("https://example.com/docs");
  });

  it("keeps non-web identity tokens as link destinations", () => {
    expect(
      resolvePostedReferenceHref(
        "workitem://auth/AUTH-12/1700000000000::encoded",
        "workitem"
      )
    ).toBe("workitem://auth/AUTH-12/1700000000000");
  });

  it("rejects an unsafe cached URL", () => {
    storePillText(
      "issue://12",
      JSON.stringify({ issueUrl: "javascript:alert(1)" })
    );
    expect(resolvePostedReferenceHref("issue://12", "issue")).toBe(
      "issue://12"
    );
    expect(isSafePostedReferenceHref("javascript:alert(1)")).toBe(false);
  });
});
