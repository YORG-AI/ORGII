import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SessionIdentityIcon, {
  SESSION_IDENTITY_ICON_SIZE,
  resolveSessionIdentityIconColorClass,
  resolveSessionIdentityIconSource,
} from "./SessionIdentityIcon";

describe("SessionIdentityIcon", () => {
  it("centers the compact glyph in the shared tab and header icon box", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionIdentityIcon, {
        session: null,
        sessionId: "session-icon-test",
      })
    );

    expect(SESSION_IDENTITY_ICON_SIZE).toBe(14);
    expect(markup).toContain("inline-flex h-4 w-4");
    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
  });
});

describe("resolveSessionIdentityIconColorClass", () => {
  it("keeps selected monochrome model icons on the foreground color", () => {
    expect(resolveSessionIdentityIconColorClass(true, true)).toBe(
      "text-text-1"
    );
  });

  it("keeps selected generic Rust agent glyphs on the secondary text color", () => {
    expect(resolveSessionIdentityIconColorClass(true, false)).toBe(
      "text-text-2"
    );
  });

  it("uses the inactive foreground for unselected monochrome icons", () => {
    expect(resolveSessionIdentityIconColorClass(false, true)).toBe(
      "text-text-2"
    );
  });
});

describe("resolveSessionIdentityIconSource", () => {
  it("uses the parked remote source identity before any local session", () => {
    expect(
      resolveSessionIdentityIconSource(
        null,
        "pending-session",
        "codex",
        undefined
      )
    ).toEqual({ session_id: "pending-session", agentIconId: "codex" });
  });

  it("keeps pending remote identity authoritative over a stale local row", () => {
    expect(
      resolveSessionIdentityIconSource(
        { session_id: "pending-session", agentIconId: "orgii" },
        "pending-session",
        "codex",
        undefined
      )
    ).toEqual({ session_id: "pending-session", agentIconId: "codex" });
  });
});
