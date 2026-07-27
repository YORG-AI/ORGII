import { describe, expect, it } from "vitest";

import {
  canonicalSessionKey,
  dedupeByCanonicalSession,
  isTwinnedSessionId,
} from "./canonicalSessionKey";

const STEM = "rollout-2026-02-09T02-32-37-019c3e86-f4b7-7700-908f-8192cfe37e6f";

describe("canonicalSessionKey", () => {
  it("collapses codex CLI and codex_app imported twins to one key", () => {
    expect(canonicalSessionKey(`codex:${STEM}`)).toBe(
      canonicalSessionKey(`codexapp-${STEM}`)
    );
  });

  it("does not collapse different stems", () => {
    expect(canonicalSessionKey(`codex:${STEM}`)).not.toBe(
      canonicalSessionKey("codex:rollout-other")
    );
  });

  it("passes non-twinned ids through unchanged", () => {
    expect(canonicalSessionKey("cursoride-abc")).toBe("cursoride-abc");
    expect(canonicalSessionKey("sdeagent-xyz")).toBe("sdeagent-xyz");
  });

  it("recognises twin prefixes", () => {
    expect(isTwinnedSessionId(`codex:${STEM}`)).toBe(true);
    expect(isTwinnedSessionId(`codexapp-${STEM}`)).toBe(true);
    expect(isTwinnedSessionId(`cursoride-${STEM}`)).toBe(false);
  });
});

describe("dedupeByCanonicalSession", () => {
  it("keeps the impact/token-richer copy of a twinned pair", () => {
    const cli = {
      session_id: `codex:${STEM}`,
      totalTokens: 1200,
      model: "gpt-5",
      category: "cli_agent",
    };
    const imported = {
      session_id: `codexapp-${STEM}`,
      filesChanged: 3,
      touchedFiles: ["a.ts", "b.ts"],
      totalTokens: 1200,
      model: "gpt-5",
      category: "external_history",
    };

    const deduped = dedupeByCanonicalSession([cli, imported]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].session_id).toBe(`codexapp-${STEM}`);
  });

  it("is order-independent in which copy survives", () => {
    const cli = { session_id: `codex:${STEM}`, category: "cli_agent" };
    const imported = {
      session_id: `codexapp-${STEM}`,
      filesChanged: 5,
      category: "external_history",
    };
    expect(dedupeByCanonicalSession([imported, cli])[0].session_id).toBe(
      `codexapp-${STEM}`
    );
    expect(dedupeByCanonicalSession([cli, imported])[0].session_id).toBe(
      `codexapp-${STEM}`
    );
  });

  it("lets an opened collaboration replay replace its visible local source", () => {
    const source = {
      session_id: `codexapp-${STEM}`,
      filesChanged: 11,
      totalTokens: 11_204_965,
      model: "gpt-5.6-sol",
      category: "external_history",
      updated_at: "2026-07-23T10:01:19.722Z",
    };
    const replay = {
      session_id: "imported-session-collaboration-copy",
      category: "external_history",
      updated_at: "2026-07-23T12:28:18.311Z",
      importedFrom: {
        sourceSessionId: `codexapp-${STEM}`,
      },
    };

    expect(dedupeByCanonicalSession([replay, source])).toEqual([replay]);
    expect(dedupeByCanonicalSession([source, replay])).toEqual([replay]);
  });

  it("keeps collaboration imports distinct when their source is not local", () => {
    const first = {
      session_id: "imported-session-org-a",
      importedFrom: { sourceSessionId: "shared-source-id" },
    };
    const second = {
      session_id: "imported-session-org-b",
      importedFrom: { sourceSessionId: "shared-source-id" },
    };

    expect(dedupeByCanonicalSession([first, second])).toEqual([first, second]);
  });

  it("preserves distinct sessions and their first-seen order", () => {
    const a = { session_id: "sdeagent-1" };
    const b = { session_id: "cursoride-2" };
    const c = { session_id: "osagent-3" };
    const deduped = dedupeByCanonicalSession([a, b, c]);
    expect(deduped.map((s) => s.session_id)).toEqual([
      "sdeagent-1",
      "cursoride-2",
      "osagent-3",
    ]);
  });
});
