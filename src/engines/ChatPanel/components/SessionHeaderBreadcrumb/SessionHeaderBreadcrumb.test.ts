import { getDefaultStore } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Session, sessionsAtom } from "@src/store/session";

import SessionHeaderBreadcrumb, {
  SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS,
  SESSION_HEADER_NAME_MAX_CHARACTERS,
  SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS,
  resolveSessionHeaderBreadcrumbDisplay,
} from ".";

vi.mock("../SessionIdentityIcon", () => ({
  default: () => React.createElement("span", null, "Session icon"),
}));

describe("session published-header breadcrumbs", () => {
  afterEach(() => {
    getDefaultStore().set(sessionsAtom, []);
  });

  it("shows an ordinary session as its canonical session name", () => {
    expect(
      resolveSessionHeaderBreadcrumbDisplay({
        sessionId: "session-1",
        sessionName: "  Refactor navigation  ",
        fallbackName: "Fallback title",
      })
    ).toEqual({
      fullDisplayName: "Refactor navigation",
      displayName: "Refactor navigation",
      segments: ["Refactor navigation"],
      isAgentChildSession: false,
    });
  });

  it("caps long session names at 40 characters including the ellipsis", () => {
    const fullDisplayName = "A".repeat(SESSION_HEADER_NAME_MAX_CHARACTERS + 20);
    const display = resolveSessionHeaderBreadcrumbDisplay({
      sessionId: "session-long-name",
      sessionName: fullDisplayName,
      fallbackName: "Fallback title",
    });

    expect(Array.from(display.displayName)).toHaveLength(
      SESSION_HEADER_NAME_MAX_CHARACTERS
    );
    expect(display.displayName).toBe(
      `${"A".repeat(SESSION_HEADER_NAME_MAX_CHARACTERS - 1)}…`
    );
    expect(display.fullDisplayName).toBe(fullDisplayName);
  });

  it("does not truncate a session name exactly at the limit", () => {
    const sessionName = "界".repeat(SESSION_HEADER_NAME_MAX_CHARACTERS);
    const display = resolveSessionHeaderBreadcrumbDisplay({
      sessionId: "session-boundary-name",
      sessionName,
      fallbackName: "Fallback title",
    });

    expect(display.displayName).toBe(sessionName);
  });

  it("shows a subagent session below its parent session", () => {
    expect(
      resolveSessionHeaderBreadcrumbDisplay({
        sessionId: "root:subagent:reviewer",
        sessionName: "Review authentication",
        fallbackName: "Fallback title",
        parentSessionId: "root",
        parentSessionName: "Schema audit",
        background: true,
      }).segments
    ).toEqual(["Schema audit", "Review authentication"]);
  });

  it("caps two-level parent and subagent names at 24 and 36 characters", () => {
    const display = resolveSessionHeaderBreadcrumbDisplay({
      sessionId: "root:subagent:reviewer",
      sessionName: "C".repeat(SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS + 10),
      fallbackName: "Fallback title",
      parentSessionId: "root",
      parentSessionName: "P".repeat(
        SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS + 10
      ),
      background: true,
    });

    expect(Array.from(display.parentDisplayName ?? "")).toHaveLength(
      SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS
    );
    expect(display.parentDisplayName).toBe(
      `${"P".repeat(SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS - 1)}…`
    );
    expect(Array.from(display.displayName)).toHaveLength(
      SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS
    );
    expect(display.displayName).toBe(
      `${"C".repeat(SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS - 1)}…`
    );
  });

  it("shows an Agent Team member session below its parent session", () => {
    expect(
      resolveSessionHeaderBreadcrumbDisplay({
        sessionId: "team-member-session",
        sessionName: "Planner session",
        fallbackName: "Fallback title",
        parentSessionId: "team-root-session",
        parentSessionName: "Release planning",
        orgMemberId: "planner",
      }).segments
    ).toEqual(["Release planning", "Planner session"]);
  });

  it("does not classify an ordinary continuation as a subagent", () => {
    expect(
      resolveSessionHeaderBreadcrumbDisplay({
        sessionId: "continued-session",
        sessionName: "Continue imported history",
        fallbackName: "Fallback title",
        parentSessionId: "imported-source",
        background: false,
      }).segments
    ).toEqual(["Continue imported history"]);
  });

  it("keeps slashes inside a session name instead of creating extra levels", () => {
    const parentSession = {
      session_id: "root",
      name: "Schema audit",
      repoPath: "/workspace/orgii",
    } as Session;
    getDefaultStore().set(sessionsAtom, [parentSession]);
    const session = {
      session_id: "root:subagent:reviewer",
      name: "Review API/auth",
      parentSessionId: "root",
      background: true,
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
        onParentSessionClick: vi.fn(),
      })
    );

    expect(markup).not.toContain("Agents");
    expect(markup).toContain("Schema audit");
    expect(markup).toContain("Review API/auth");
    expect(markup).toContain('title="Review API/auth"');
    expect(markup).toContain('title="Schema audit"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup.match(/Session icon/g)).toHaveLength(2);
    expect(markup.match(/lucide-chevron-right/g)).toHaveLength(1);
    expect(markup).not.toMatch(
      /flex min-w-0 flex-1 items-center gap-0\.5[^"]* px-1/
    );
  });
});
