// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import {
  type SmokeRoot,
  createSmokeRoot,
  dispatch,
} from "@src/test/reactSmokeHarness";

import { cloudDownloadPendingPlayAtom } from "./cloudSessionDownloadControlAtoms";
import { cloudSessionDownloadProgressAtom } from "./cloudSessionDownloadProgressAtom";
import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  useCloudSessionDownloadProgressEntry,
  useCloudSessionHasDownloadSurface,
  useCloudSessionLoadingSource,
  useCloudSessionPendingPlayEntry,
} from "./useCloudSessionDownloadSurface";

const AUTH_A: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-a",
  accessToken: "jwt-a",
  refreshToken: "refresh-a",
  expiresAt: 4_000_000_000,
};

const AUTH_B: Org2CloudAuthState = {
  ...AUTH_A,
  userId: "user-b",
  accessToken: "jwt-b",
  refreshToken: "refresh-b",
};

function source(ownerUserId: string): RemoteTeammateSessionMetadata {
  return {
    id: `row-${ownerUserId}`,
    orgId: "org-1",
    ownerMemberId: `member-${ownerUserId}`,
    ownerUserId,
    ownerDisplayName: ownerUserId,
    ownerIdentityKind: "human",
    sourceSessionId: "source-1",
    title: "Shared session",
    eventsEpoch: 1,
    eventsFrozenSeq: 2,
    eventsCount: 3,
    eventsTailHash: "tail",
  };
}

describe("Cloud download surface auth identity", () => {
  let root: SmokeRoot | null = null;

  afterEach(async () => {
    await root?.unmount();
    root = null;
  });

  it("hides pending/progress source data immediately after an account switch", async () => {
    const store = createStore();
    const identityA = org2CloudAuthIdentityKey(AUTH_A);
    const sourceA = source("user-a");
    store.set(org2CloudAuthAtom, AUTH_A);
    store.set(
      cloudDownloadPendingPlayAtom,
      new Map([
        [
          "imported-session-1",
          {
            authIdentityKey: identityA,
            rowId: sourceA.id,
            orgId: "org-1",
            sourceSession: sourceA,
            iconId: "codex",
            pendingEvents: 3,
            etaMs: 1_000,
            kind: "replay" as const,
          },
        ],
      ])
    );
    store.set(
      cloudSessionDownloadProgressAtom,
      new Map([
        [
          "imported-session-1",
          {
            authIdentityKey: identityA,
            rowId: sourceA.id,
            orgId: "org-1",
            sourceSession: sourceA,
            loadedEvents: 1,
            totalEvents: 3,
            startedAtMs: 1,
            updatedAtMs: 2,
            phase: "downloading" as const,
          },
        ],
      ])
    );

    const Harness = () => {
      const loadingSource = useCloudSessionLoadingSource("imported-session-1");
      const progress =
        useCloudSessionDownloadProgressEntry("imported-session-1");
      const pending = useCloudSessionPendingPlayEntry("imported-session-1");
      const hasSurface =
        useCloudSessionHasDownloadSurface("imported-session-1");
      return createElement("output", {
        "data-has-surface": String(hasSurface),
        "data-pending-user-id": pending?.sourceSession.ownerUserId ?? "",
        "data-progress-user-id": progress?.sourceSession?.ownerUserId ?? "",
        "data-source-user-id": loadingSource?.ownerUserId ?? "",
      });
    };
    const readSurface = () => {
      const output = root?.container.querySelector("output");
      return {
        hasSurface: output?.getAttribute("data-has-surface") === "true",
        pendingUserId:
          output?.getAttribute("data-pending-user-id") || undefined,
        progressUserId:
          output?.getAttribute("data-progress-user-id") || undefined,
        sourceUserId: output?.getAttribute("data-source-user-id") || undefined,
      };
    };

    root = createSmokeRoot();
    await root.render(
      createElement(Provider, { store }, createElement(Harness))
    );
    expect(readSurface()).toEqual({
      sourceUserId: "user-a",
      progressUserId: "user-a",
      pendingUserId: "user-a",
      hasSurface: true,
    });

    await dispatch(() => store.set(org2CloudAuthAtom, AUTH_B));
    expect(readSurface()).toEqual({
      sourceUserId: undefined,
      progressUserId: undefined,
      pendingUserId: undefined,
      hasSurface: false,
    });
  });
});
