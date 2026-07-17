/**
 * Regression coverage for adapter routing.
 *
 * Cursor IDE history carries a distinct `cursor_ide` *display* category (so the
 * UI can separate imported IDE history from launched Cursor CLI sessions), but
 * for *loading* it is read-only external history and must resolve to the
 * `external_history` adapter. A prior change flipped Cursor's category to
 * `cursor_ide` and left the loader gated on `isExternalHistorySession`, so
 * `getAdapterForSession` returned `undefined` for Cursor sessions and the chat
 * pane rendered an empty state. This test locks Cursor to a loading adapter.
 */
import { describe, expect, it } from "vitest";

// Importing the registry module registers every adapter as a side-effect,
// which is what `getAdapterForSession` reads from.
import "../adapters";
import { getAdapterForSession } from "../types";

describe("getAdapterForSession", () => {
  it("routes Cursor IDE history sessions to the external_history adapter", () => {
    const adapter = getAdapterForSession(
      "cursoride-b15be46d-5ced-468f-a5e3-441dd84fef93"
    );
    expect(adapter?.category).toBe("external_history");
  });

  it("routes other imported external history sessions to the same adapter", () => {
    expect(getAdapterForSession("codexapp-abc")?.category).toBe(
      "external_history"
    );
    expect(getAdapterForSession("claudecodeapp-abc")?.category).toBe(
      "external_history"
    );
    expect(getAdapterForSession("opencodeapp-abc")?.category).toBe(
      "external_history"
    );
  });

  it("still routes CLI and agent sessions to their own adapters", () => {
    expect(getAdapterForSession("cliagent-abc")?.category).toBe("cli");
    expect(getAdapterForSession("osagent-abc")?.category).toBe("agent");
  });

  it("returns undefined for unknown session ids", () => {
    expect(getAdapterForSession("totally-unknown-abc")).toBeUndefined();
  });
});
