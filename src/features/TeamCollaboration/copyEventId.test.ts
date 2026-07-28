import { describe, expect, it } from "vitest";

import { namespaceCopyEventId, stripCopyEventNamespace } from "./copyEventId";

describe("copyEventId namespacing", () => {
  const sid = "imported-session-abc123";

  it("namespaces a bare source id under the local session", () => {
    expect(namespaceCopyEventId(sid, "user-message-1")).toBe(
      `${sid}~user-message-1`
    );
  });

  it("is idempotent — re-namespacing does not double-prefix", () => {
    const once = namespaceCopyEventId(sid, "tool-call-x");
    expect(namespaceCopyEventId(sid, once)).toBe(once);
  });

  it("strips back to the source id", () => {
    const wrapped = namespaceCopyEventId(sid, "stream-msg-7");
    expect(stripCopyEventNamespace(sid, wrapped)).toBe("stream-msg-7");
  });

  it("strip is identity for an id that is not namespaced by this session", () => {
    expect(stripCopyEventNamespace(sid, "user-message-1")).toBe(
      "user-message-1"
    );
    expect(stripCopyEventNamespace(sid, "other-session~evt")).toBe(
      "other-session~evt"
    );
  });

  it("keeps distinct copies disjoint for the same source id", () => {
    const fork = "agentsession-fork";
    const imported = "imported-session-parent";
    expect(namespaceCopyEventId(fork, "evt-1")).not.toBe(
      namespaceCopyEventId(imported, "evt-1")
    );
  });

  it("introduces no colon (parseActivityId classification stays intact)", () => {
    expect(namespaceCopyEventId(sid, "user-message-1")).not.toContain(":");
  });
});
