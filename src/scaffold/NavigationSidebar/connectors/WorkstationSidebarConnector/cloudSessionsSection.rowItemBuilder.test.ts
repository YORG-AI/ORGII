import { Provider } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";

import {
  cloudSessionHasLocalCopy,
  useCloudSessionRowItemBuilder,
} from "./cloudSessionsSection.rowItemBuilder";

vi.mock("@src/config/agentIcons", () => ({
  resolveAgentIcon: () => (props: { size?: number }) =>
    createElement("i", {
      "data-agent-icon": "stub",
      "data-size": props.size,
    }),
}));

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SOURCE_ENDPOINT = "https://cloud.example.com";

const remoteRow: RemoteTeammateSessionMetadata = {
  id: "remote-row-1",
  orgId: ORG_ID,
  ownerMemberId: "member-1",
  ownerUserId: OWNER_USER_ID,
  ownerDisplayName: "Alice",
  ownerIdentityKind: "human",
  sourceSessionId: "source-session-1",
  title: "Cloud-only session",
  eventsEpoch: 1,
  eventsFrozenSeq: 0,
  eventsCount: 1,
  eventsTailHash: "hash",
};

function importedCopy(sourceEndpointUrl = SOURCE_ENDPOINT): Session {
  return {
    session_id: "imported-session-1",
    importedFrom: {
      orgId: ORG_ID,
      sourceSessionId: remoteRow.sourceSessionId,
      sourceEndpointUrl,
      ownerMemberId: remoteRow.ownerMemberId,
      epoch: 1,
      seq: 0,
      count: 1,
    },
  } as Session;
}

function renderCloudRowAccessory(
  options: {
    sessions?: readonly Session[];
    selfUserId?: string | null;
    localOwnSessionIds?: ReadonlySet<string>;
  } = {}
): string {
  const Probe = () => {
    const buildRowItem = useCloudSessionRowItemBuilder({
      presenceMap: {},
      selfUserId: options.selfUserId ?? null,
      sessions: options.sessions ?? [],
      localOwnSessionIds: options.localOwnSessionIds ?? new Set<string>(),
      sourceEndpointUrl: SOURCE_ENDPOINT,
      t: ((key: string) => key) as never,
      tCommon: ((key: string) => key) as never,
      runFork: vi.fn(),
      buildNativeMenuItems: () => [],
      busySessionRows: new Map(),
      pinnedRemoteSessionIds: new Set(),
      toggleRemoteSessionPin: vi.fn(),
    });
    const item = buildRowItem({
      row: remoteRow,
      bareSessionId: remoteRow.sourceSessionId,
      isOrphan: false,
    });
    return createElement("div", null, item.trailingElement);
  };

  return renderToStaticMarkup(
    createElement(Provider, null, createElement(Probe))
  );
}

describe("cloud session local-copy indicator", () => {
  it("shows a trailing cloud icon when the remote row has no local copy", () => {
    const markup = renderCloudRowAccessory();

    expect(markup).toContain('data-icon="cloud"');
    expect(markup).toContain('aria-label="sidebar.groups.cloud"');
  });

  it("hides the cloud icon once an imported replay copy exists locally", () => {
    const sessions = [importedCopy()];

    expect(
      cloudSessionHasLocalCopy(
        remoteRow,
        sessions,
        null,
        new Set(),
        SOURCE_ENDPOINT
      )
    ).toBe(true);
    expect(renderCloudRowAccessory({ sessions })).not.toContain(
      'data-icon="cloud"'
    );
  });

  it("hides the cloud icon for the viewer's writable local original", () => {
    expect(
      renderCloudRowAccessory({
        selfUserId: OWNER_USER_ID,
        localOwnSessionIds: new Set([remoteRow.sourceSessionId]),
      })
    ).not.toContain('data-icon="cloud"');
  });

  it("does not reuse a copy imported from another cloud deployment", () => {
    const sessions = [importedCopy("https://other-cloud.example.com")];

    expect(
      cloudSessionHasLocalCopy(
        remoteRow,
        sessions,
        null,
        new Set(),
        SOURCE_ENDPOINT
      )
    ).toBe(false);
    expect(renderCloudRowAccessory({ sessions })).toContain(
      'data-icon="cloud"'
    );
  });
});
