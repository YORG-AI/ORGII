import { describe, expect, it, vi } from "vitest";

import { resolveAgentIcon } from "@src/config/agentIcons";
import { UserMultipleIcon } from "@src/icons";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import {
  buildCloudSessionReferenceItem,
  buildSpotlightSessionItems,
  resolveAgentSessionSearchInput,
  resolveSpotlightCloudSessionPresentation,
} from "../spotlightSessionSearch";

const SESSION_ID =
  "codexapp-rollout-2026-07-29T17-21-00-019fad2d-620b-7971-a0f6-c76b92c38483";
const REFERENCE = `orgii://cloud/session/ref?v=1&org=bfa7b134-2486-45fa-81ad-a369441fafb4&owner=776dbd69-ac1d-4f72-a0d4-69cb4f2667dd&session=${SESSION_ID}`;

describe("resolveAgentSessionSearchInput", () => {
  it("preserves a raw session id as free-text search", () => {
    expect(resolveAgentSessionSearchInput(SESSION_ID)).toEqual({
      query: SESSION_ID,
      reference: null,
    });
  });

  it("recognizes a copied cloud reference and extracts its source id", () => {
    expect(resolveAgentSessionSearchInput(REFERENCE)).toEqual({
      query: SESSION_ID,
      reference: {
        version: 1,
        orgId: "bfa7b134-2486-45fa-81ad-a369441fafb4",
        ownerUserId: "776dbd69-ac1d-4f72-a0d4-69cb4f2667dd",
        sourceSessionId: SESSION_ID,
      },
    });
  });

  it("fails malformed references closed and leaves them searchable as text", () => {
    const malformed =
      "orgii://cloud/session/ref?v=1&org=org-1&session=session-1";
    expect(resolveAgentSessionSearchInput(malformed)).toEqual({
      query: malformed,
      reference: null,
    });
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    session_id: SESSION_ID,
    status: "completed",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    name: "Rollout notes",
    ...overrides,
  };
}

describe("buildSpotlightSessionItems", () => {
  it("caps general Spotlight results and exposes the matched raw identity", () => {
    const items = buildSpotlightSessionItems({
      sessions: [
        session(),
        session({ session_id: `${SESSION_ID}-older` }),
        session({ session_id: `${SESSION_ID}-oldest` }),
      ],
      fallbackSessionLabel: "Session",
      visitedSessions: new Set(),
      query: SESSION_ID,
      onSelect: vi.fn(),
      limit: 2,
      idPrefix: "general-session",
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: `general-session:${SESSION_ID}`,
      label: "Rollout notes",
      desc: SESSION_ID,
    });
  });

  it("opens the selected session with its resolved display name", () => {
    const onSelect = vi.fn();
    const source = session();
    const [item] = buildSpotlightSessionItems({
      sessions: [source],
      fallbackSessionLabel: "Session",
      visitedSessions: new Set([SESSION_ID]),
      query: "rollout",
      onSelect,
    });

    item.action?.();
    expect(onSelect).toHaveBeenCalledWith(source, "Rollout notes");
  });

  it("builds an identity-preserving cloud reference action", () => {
    const resolved = resolveAgentSessionSearchInput(REFERENCE);
    const onSelect = vi.fn();
    expect(resolved.reference).not.toBeNull();

    const TestIcon = () => null;
    const item = buildCloudSessionReferenceItem({
      reference: resolved.reference!,
      label: "Team session",
      icon: TestIcon,
      onSelect,
      idPrefix: "general-cloud-session",
    });

    expect(item).toMatchObject({
      id: `general-cloud-session:bfa7b134-2486-45fa-81ad-a369441fafb4:776dbd69-ac1d-4f72-a0d4-69cb4f2667dd:${SESSION_ID}`,
      label: "Team session",
      desc: SESSION_ID,
    });
    expect(item.icon).toBe(TestIcon);
    item.action?.();
    expect(onSelect).toHaveBeenCalledWith(resolved.reference);
  });
});

describe("resolveSpotlightCloudSessionPresentation", () => {
  const reference = resolveAgentSessionSearchInput(REFERENCE).reference!;
  const auth = {
    supabaseUrl: "https://cloud.example.com",
    userId: "viewer-user",
  };
  const identityKey = `${auth.supabaseUrl}|${auth.userId}`;
  const remoteRow = {
    id: "cloud-row",
    orgId: reference.orgId,
    ownerUserId: reference.ownerUserId,
    sourceSessionId: reference.sourceSessionId,
    title: "Codex rollout follow-up",
    cliAgentType: "codex",
  } as RemoteTeammateSessionMetadata;

  it("uses the exact cached cloud row title and agent icon", () => {
    const presentation = resolveSpotlightCloudSessionPresentation({
      reference,
      fallbackLabel: "Team session",
      auth,
      remoteEntries: {
        [reference.orgId]: {
          identityKey,
          rows: [remoteRow],
          state: "ready",
          fetchedAt: 1,
        },
      },
      localSessions: [],
    });

    const remoteDisplay = resolveSessionDisplayMetadata({
      kind: "remote",
      session: remoteRow,
    });
    expect(presentation).toEqual({
      label: "Codex rollout follow-up",
      icon: resolveAgentIcon(remoteDisplay.agentIconId),
    });
  });

  it("does not read rows cached for a different signed-in identity", () => {
    const presentation = resolveSpotlightCloudSessionPresentation({
      reference,
      fallbackLabel: "Team session",
      auth,
      remoteEntries: {
        [reference.orgId]: {
          identityKey: "https://cloud.example.com|previous-user",
          rows: [remoteRow],
          state: "ready",
          fetchedAt: 1,
        },
      },
      localSessions: [],
    });

    expect(presentation).toEqual({
      label: "Team session",
      icon: UserMultipleIcon,
    });
  });

  it("uses matching local presentation only for the reference owner", () => {
    const ownerAuth = { ...auth, userId: reference.ownerUserId };
    const local = session({ name: "My local rollout session" });

    expect(
      resolveSpotlightCloudSessionPresentation({
        reference,
        fallbackLabel: "Team session",
        auth: ownerAuth,
        remoteEntries: {},
        localSessions: [local],
      })
    ).toEqual({
      label: "My local rollout session",
      icon: resolveSessionRowIcon(local),
    });
    expect(
      resolveSpotlightCloudSessionPresentation({
        reference,
        fallbackLabel: "Team session",
        auth,
        remoteEntries: {},
        localSessions: [local],
      })
    ).toEqual({
      label: "Team session",
      icon: UserMultipleIcon,
    });
  });
});
