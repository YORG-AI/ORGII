import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import NavigationMenu from "@src/scaffold/NavigationSidebar/components/NavigationMenu";
import type { Session } from "@src/store/session";

import { buildSessionMenuItem } from "./menuItemBuilders";

function row(status: Session["status"]) {
  return buildSessionMenuItem({
    session: {
      session_id: `session-${status}`,
      status,
      created_at: "2026-08-10T00:00:00.000Z",
      updated_at: "2026-08-10T00:00:00.000Z",
    },
    untitledSession: "Untitled",
    visitedSessions: new Set(),
  });
}

describe("buildSessionMenuItem status dot", () => {
  it.each([
    ["running", "Active", "bg-primary-6"],
    ["completed", "Completed", "bg-success-6"],
    ["error", "Error", "bg-danger-6"],
  ] as const)(
    "keeps the %s session status dot in the trailing slot",
    (status, label, color) => {
      const item = row(status);
      const markup = renderToStaticMarkup(<>{item.trailingElement}</>);

      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(color);
    }
  );

  it("keeps the working animation in addition to the active dot", () => {
    const item = row("running");

    expect(item.workingIndicator).toBeDefined();
    expect(item.trailingElement).toBeDefined();
  });

  it("renders the status dot in the NavigationMenu trailing row accessory", () => {
    const item = row("completed");
    const markup = renderToStaticMarkup(
      <NavigationMenu
        items={[item]}
        selectedKeys={[]}
        onMenuItemClick={() => undefined}
      />
    );

    expect(markup).toMatch(
      /sidebar-session-item-session-completed[\s\S]*aria-label="Completed"/
    );
  });
});
