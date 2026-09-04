import { describe, expect, it } from "vitest";

import { resolveMarkdownFileRootPath } from "./markdownWorkspaceRoot";

/**
 * A transcript recorded in repo A and read while repo B is focused must keep
 * resolving its file references against A. Reading the active-workspace atom
 * alone re-pointed every link the moment the reader switched projects, so the
 * event's own stamp wins whenever it carries one.
 */
describe("resolveMarkdownFileRootPath", () => {
  const ACTIVE = "/Users/dev/GitHub/ORGII";
  const EVENT = "/Users/dev/GitHub/orgii-cloud-infra";

  it("prefers the repo the event was recorded in", () => {
    expect(resolveMarkdownFileRootPath(EVENT, ACTIVE)).toBe(EVENT);
  });

  it("falls back to the focused workspace when the event carries no stamp", () => {
    expect(resolveMarkdownFileRootPath(undefined, ACTIVE)).toBe(ACTIVE);
  });

  it("treats an empty or whitespace stamp as absent", () => {
    expect(resolveMarkdownFileRootPath("", ACTIVE)).toBe(ACTIVE);
    expect(resolveMarkdownFileRootPath("   ", ACTIVE)).toBe(ACTIVE);
  });

  it("returns an empty root when neither source knows one", () => {
    expect(resolveMarkdownFileRootPath(undefined, undefined)).toBe("");
    expect(resolveMarkdownFileRootPath("", "")).toBe("");
  });

  it("trims a padded stamp rather than joining hrefs onto whitespace", () => {
    expect(resolveMarkdownFileRootPath(` ${EVENT} `, ACTIVE)).toBe(EVENT);
  });
});
