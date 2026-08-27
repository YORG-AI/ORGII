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

// The suite's i18next instance is not wired through `initReactI18next`, so
// `useTranslation` echoes keys instead of English text. Assert the key: it is
// what pins the badge to a real string, and it survives copy edits.
const SUBAGENT_TAG_KEY = "sessionBadge.subagent";

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

  it("shows an imported session owner after the session name", () => {
    const session = {
      session_id: "imported-session-1",
      name: "Optimize session sidebar loading",
      category: "external_history",
      importedFrom: {
        orgId: "org-1",
        sourceSessionId: "remote-session-1",
        ownerMemberId: "member-1",
        ownerDisplayName: "  Ada Lovelace-Smith  ",
        epoch: 1,
        seq: 2,
        count: 3,
      },
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
      })
    );

    expect(markup).toContain("Optimize session sidebar loading");
    expect(markup).toContain("h-4 w-px shrink-0 bg-border-2");
    expect(markup).toContain(">Ada Lovela...</span>");
    expect(markup).toContain(
      'title="Optimize session sidebar loading | Ada Lovelace-Smith"'
    );
  });

  it("keeps a ten-character imported owner name unchanged", () => {
    const session = {
      session_id: "imported-session-2",
      name: "Review session",
      importedFrom: {
        ownerDisplayName: "1234567890",
      },
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
      })
    );

    expect(markup).toContain(">1234567890</span>");
    expect(markup).not.toContain("1234567890...");
  });

  it("keeps the owner suffix out of personal session headers", () => {
    const session = {
      session_id: "personal-session-1",
      name: "Personal session",
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
      })
    );

    expect(markup).toContain("Personal session");
    expect(markup).not.toContain("h-4 w-px shrink-0 bg-border-2");
    expect(markup).not.toContain(SUBAGENT_TAG_KEY);
  });

  it("tags an agent-started child session as a subagent", () => {
    const parentSession = {
      session_id: "root",
      name: "Key trading VM launch",
    } as Session;
    getDefaultStore().set(sessionsAtom, [parentSession]);
    const session = {
      session_id: "root:subagent:translator",
      name: "Translate wave 1 to ko/de/es",
      parentSessionId: "root",
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
      })
    );

    expect(markup).toContain("Translate wave 1 to ko/de/es");
    expect(markup).toContain(SUBAGENT_TAG_KEY);
    expect(markup).toContain('title="Translate wave 1 to ko/de/es"');
  });

  it("tags an Agent Team member session as a subagent", () => {
    const session = {
      session_id: "member-session-1",
      name: "Review API",
      parentSessionId: "root",
      orgMemberId: "member-1",
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
      })
    );

    expect(markup).toContain(SUBAGENT_TAG_KEY);
  });

  it("leaves an ordinary continuation session untagged", () => {
    const session = {
      session_id: "continued-session",
      name: "Continue imported history",
      parentSessionId: "imported-source",
      background: false,
    } as Session;
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderBreadcrumb, {
        session,
        sessionId: session.session_id,
        fallbackName: "Fallback title",
      })
    );

    expect(markup).toContain("Continue imported history");
    expect(markup).not.toContain(SUBAGENT_TAG_KEY);
  });
});
