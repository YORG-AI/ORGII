import { defaultUrlTransform } from "react-markdown";
import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import { markdownUrlTransform } from "./markdownUrlTransform";

const REFERENCE = buildCloudSessionReference({
  orgId: "0830d453-1111-4222-8333-444455556666",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "sdeagent-1784668132283",
});

describe("markdown url transform", () => {
  it("proves the default sanitizer would drop a session reference", () => {
    expect(defaultUrlTransform(REFERENCE)).toBe("");
  });

  it("proves the default sanitizer would drop supported local href forms", () => {
    expect(defaultUrlTransform("file:///Users/me/project/View.tsx:220")).toBe(
      ""
    );
    expect(defaultUrlTransform("C:\\repo\\src\\View.tsx:220")).toBe("");
    expect(defaultUrlTransform("WebsiteCard.tsx:84")).toBe("");
  });

  it("passes a valid session reference through on a link href", () => {
    expect(markdownUrlTransform(REFERENCE, "href")).toBe(REFERENCE);
  });

  it("passes projected composer references through on link hrefs", () => {
    const workItem = "workitem://auth/AUTH-12/1700000000000";
    expect(markdownUrlTransform(workItem, "href")).toBe(workItem);
    expect(markdownUrlTransform(workItem, "src")).toBe("");
  });

  it.each([
    "/Users/me/project/View.tsx:220",
    "file:///Users/me/project/View.tsx:220",
    "C:\\repo\\src\\View.tsx:220",
    "asset://localhost/Users/me/project/View.tsx:220",
    "~/project/View.tsx:220",
  ])("passes a supported local file reference through on href: %s", (href) => {
    expect(markdownUrlTransform(href, "href")).toBe(href);
  });

  it.each([
    "WebsiteCard.tsx:84",
    "src/components/MarkDown/LinkHoverCard.tsx:80",
    "docs/architecture.md",
  ])("preserves a workspace-relative file href: %s", (href) => {
    expect(markdownUrlTransform(href, "href")).toBe(href);
  });

  it("refuses the scheme on every non-href url attribute", () => {
    // react-markdown runs the transform over src/poster/cite too; only the
    // link path has a reference renderer, so nothing else may carry the scheme.
    for (const key of ["src", "poster", "cite", "action", undefined]) {
      expect(markdownUrlTransform(REFERENCE, key)).toBe("");
    }
  });

  it("keeps local-only schemes blocked on non-href attributes", () => {
    for (const value of [
      "file:///Users/me/project/View.tsx",
      "C:\\repo\\src\\View.tsx",
      "asset://localhost/Users/me/project/View.tsx",
    ]) {
      expect(markdownUrlTransform(value, "src")).toBe("");
    }
  });

  it("keeps sanitizing every other scheme, including near-misses", () => {
    expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
    expect(markdownUrlTransform("data:text/html,<script>", "href")).toBe("");
    expect(markdownUrlTransform("orgii://cloud/session?share=deadbeef")).toBe(
      ""
    );
    expect(
      markdownUrlTransform(
        "orgii://cloud/session/ref?v=2&org=a&owner=b&session=c"
      )
    ).toBe("");
  });

  it("leaves ordinary links alone", () => {
    expect(markdownUrlTransform("https://github.com/org2AI/ORG2")).toBe(
      "https://github.com/org2AI/ORG2"
    );
    expect(markdownUrlTransform("./relative/path.md")).toBe(
      "./relative/path.md"
    );
  });
});
