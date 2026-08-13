import { describe, expect, it } from "vitest";

import { parseOrgtrackEnvelope } from "../cardParsers";

const shell = (command: string) => ({ command });

describe("parseOrgtrackEnvelope", () => {
  it("renders a successful work.create envelope as a card", () => {
    const card = parseOrgtrackEnvelope(shell("org2-pm work create --title x"), {
      exit_code: 0,
      stdout: JSON.stringify({
        apiVersion: "orgtrack/v1",
        ok: true,
        data: {
          frontmatter: { short_id: "AAA-0001", title: "x", status: "backlog" },
        },
      }),
    });
    expect(card).not.toBeNull();
    expect(card?.ok).toBe(true);
    expect(card?.operationId).toBe("work.create");
    expect(card?.operation).toBe("Created work item");
    expect(card?.shortId).toBe("AAA-0001");
  });

  it("keeps the canonical created item and injected project context", () => {
    const stdout = JSON.stringify({
      apiVersion: "orgtrack/v1",
      ok: true,
      data: {
        body: "Deliver the card",
        filename: "AAA-0002",
        frontmatter: {
          id: "AAA-0002",
          short_id: "AAA-0002",
          title: "Clickable result",
          project: "project-row-id",
          status: "planned",
          priority: "high",
          labels: [],
          todos: [],
          starred: false,
          created_at: "2026-08-09T00:00:00Z",
          updated_at: "2026-08-09T00:00:00Z",
        },
      },
    });
    const card = parseOrgtrackEnvelope(
      shell("org2-pm work create --title x"),
      { output: { success: { stdout, exitCode: 0 } } },
      {
        projectSlug: "app-shell",
        projectName: "App Shell",
        projectId: "project-row-id",
        orgId: "org-1",
      }
    );

    expect(card).toMatchObject({
      operationId: "work.create",
      projectSlug: "app-shell",
      projectName: "App Shell",
      projectId: "project-row-id",
      orgId: "org-1",
      isStandalone: false,
    });
    expect(card?.workItem?.frontmatter.short_id).toBe("AAA-0002");
  });

  it("marks standalone creates without borrowing session project context", () => {
    const card = parseOrgtrackEnvelope(
      shell("org2-pm work create --standalone --title x"),
      {
        stdout: JSON.stringify({
          apiVersion: "orgtrack/v1",
          ok: true,
          data: {
            body: "",
            filename: "WI-0099",
            frontmatter: {
              id: "WI-0099",
              short_id: "WI-0099",
              title: "Standalone card",
              status: "backlog",
              priority: "none",
              labels: [],
              todos: [],
              starred: false,
              created_at: "2026-08-09T00:00:00Z",
              updated_at: "2026-08-09T00:00:00Z",
            },
          },
        }),
      },
      { projectSlug: "must-not-leak" }
    );

    expect(card?.isStandalone).toBe(true);
    expect(card?.projectSlug).toBeUndefined();
    expect(card?.workItem?.frontmatter.short_id).toBe("WI-0099");
  });

  it("keeps a standalone work.update item navigable for a host-bootstrapped root", () => {
    const card = parseOrgtrackEnvelope(
      shell("org2-pm work update WI-0100 --standalone --title x"),
      {
        stdout: JSON.stringify({
          apiVersion: "orgtrack/v1",
          ok: true,
          data: {
            body: "Original request",
            filename: "WI-0100",
            frontmatter: {
              id: "WI-0100",
              short_id: "WI-0100",
              title: "Updated root",
              status: "backlog",
              priority: "none",
              labels: [],
              todos: [],
              starred: false,
              created_at: "2026-08-09T00:00:00Z",
              updated_at: "2026-08-09T00:01:00Z",
            },
          },
        }),
      }
    );

    expect(card).toMatchObject({
      operationId: "work.update",
      isStandalone: true,
      shortId: "WI-0100",
      title: "Updated root",
    });
    expect(card?.workItem?.frontmatter.short_id).toBe("WI-0100");
  });

  it("recovers a navigable update card when a shell pipeline truncates the envelope", () => {
    const card = parseOrgtrackEnvelope(
      shell(
        'org2-pm work update WI-0106 --standalone --title "vince222" --output json 2>&1 | head -40'
      ),
      {
        stdout: `{
  "apiVersion": "orgtrack/v1",
  "ok": true,
  "data": {
    "body": "request",
    "filename": "WI-0106",
    "frontmatter": {
      "origin_session": {
        "provider": "org2",
`,
      }
    );

    expect(card).toMatchObject({
      operationId: "work.update",
      operation: "Updated work item",
      shortId: "WI-0106",
      title: "vince222",
      isStandalone: true,
    });
    expect(card?.workItem).toBeUndefined();
  });

  it("does not recover truncated output without a confirmed successful envelope", () => {
    expect(
      parseOrgtrackEnvelope(
        shell("org2-pm work update WI-0106 --standalone | head -1"),
        { exit_code: 0, stdout: '{\n  "apiVersion": "orgtrack/v1"' }
      )
    ).toBeNull();
  });

  it("renders an error envelope with the wire code", () => {
    const card = parseOrgtrackEnvelope(shell("org2-pm work claim AAA-0001"), {
      exit_code: 4,
      stdout: JSON.stringify({
        apiVersion: "orgtrack/v1",
        ok: false,
        error: { code: "ALREADY_CLAIMED", message: "taken", retryable: false },
      }),
    });
    expect(card?.ok).toBe(false);
    expect(card?.errorCode).toBe("ALREADY_CLAIMED");
  });

  it("counts items for a list envelope", () => {
    const card = parseOrgtrackEnvelope(shell("org2-pm work list"), {
      exit_code: 0,
      stdout: JSON.stringify({
        apiVersion: "orgtrack/v1",
        ok: true,
        data: { items: [{}, {}, {}] },
      }),
    });
    expect(card?.itemCount).toBe(3);
    expect(card?.workItem).toBeUndefined();
  });

  it("ignores non-org2-pm commands and non-envelope output", () => {
    expect(parseOrgtrackEnvelope(shell("ls -la"), { stdout: "{}" })).toBeNull();
    expect(
      parseOrgtrackEnvelope(shell("org2-pm work list"), { stdout: "not json" })
    ).toBeNull();
    expect(
      parseOrgtrackEnvelope(shell("org2-pm work list"), {
        stdout: JSON.stringify({ apiVersion: "other/v1", ok: true }),
      })
    ).toBeNull();
  });
});
