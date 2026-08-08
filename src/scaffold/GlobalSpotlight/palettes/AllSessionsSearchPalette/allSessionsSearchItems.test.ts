import { describe, expect, it, vi } from "vitest";

import type { CrossSessionSearchHit } from "@src/api/tauri/rpc/schemas/sessionCore";
import type { Session } from "@src/store/session";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import { buildAllSessionsSearchItems } from "./allSessionsSearchItems";

function session(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "session-1",
    status: "completed",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    name: "Search result session",
    cliAgentType: "codex",
    repoPath: "/workspace/repo",
    ...overrides,
  };
}

function hit(overrides: Partial<CrossSessionSearchHit> = {}) {
  return {
    sessionId: "session-1",
    snippet: "Found <mark>index.ts</mark> in the note",
    timestamp: "2026-07-30T00:00:00.000Z",
    rank: 0,
    ...overrides,
  };
}

describe("buildAllSessionsSearchItems", () => {
  it("shows the matched note and canonical session agent icon", () => {
    const source = session();
    const items = buildAllSessionsSearchItems({
      hits: [hit()],
      sessionMap: new Map([[source.session_id, source]]),
      fallbackSessionLabel: "Session",
      onNavigate: vi.fn(),
    });

    expect(items[0]).toMatchObject({
      id: source.session_id,
      label: "Search result session",
      desc: "Found index.ts in the note",
      icon: resolveSessionRowIcon(source),
      type: "option",
      data: { iconTone: "text1" },
    });
    expect(items[0]).not.toHaveProperty("description");
  });

  it("falls back safely when cached metadata is unavailable", () => {
    const onNavigate = vi.fn();
    const items = buildAllSessionsSearchItems({
      hits: [hit({ sessionId: "missing-session" })],
      sessionMap: new Map(),
      fallbackSessionLabel: "Session",
      onNavigate,
    });

    expect(items[0]).toMatchObject({
      label: "Session",
      icon: resolveSessionRowIcon("missing-session"),
    });
    items[0].action?.();
    expect(onNavigate).toHaveBeenCalledWith("missing-session", "Session", "");
  });
});
