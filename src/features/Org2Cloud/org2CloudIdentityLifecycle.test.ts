import { getDefaultStore } from "jotai";
import { beforeAll, describe, expect, it } from "vitest";

import {
  readIdentitySnapshot,
  replaceIdentitySnapshot,
} from "@src/features/Identity/identitySnapshotAtom";
import type {
  IdentitySession,
  IdentitySnapshot,
} from "@src/features/Identity/identityTypes";

import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import {
  didOrg2CloudIdentityChange,
  installOrg2CloudIdentityLifecycle,
} from "./org2CloudIdentityLifecycle";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";

const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_B = "00000000-0000-4000-8000-000000000002";

function session(
  sessionId: string,
  subject: string,
  generation: number
): IdentitySession {
  return {
    sessionId,
    realm: "org2_cloud",
    issuer: "https://cloud.example.test",
    subject,
    scopes: ["openid"],
    status: "ready",
    generation,
  };
}

function snapshot(
  revision: number,
  identity: IdentitySession | null
): IdentitySnapshot {
  return {
    revision,
    sessions: identity ? [identity] : [],
    activeSessions: identity ? { org2_cloud: identity.sessionId } : {},
    flows: [],
    secureStoreStatus: "available",
  };
}

beforeAll(() => installOrg2CloudIdentityLifecycle());

describe("ORG2 Cloud identity cache lifecycle", () => {
  it("distinguishes revision-only updates from identity generations", () => {
    const current = snapshot(1, session(SESSION_A, "user-a", 1));
    expect(
      didOrg2CloudIdentityChange(
        current,
        snapshot(2, session(SESSION_A, "user-a", 1))
      )
    ).toBe(false);
    expect(
      didOrg2CloudIdentityChange(
        current,
        snapshot(2, session(SESSION_A, "user-a", 2))
      )
    ).toBe(true);
    expect(
      didOrg2CloudIdentityChange(
        current,
        snapshot(2, session(SESSION_B, "user-b", 2))
      )
    ).toBe(true);
  });

  it("evicts account A data before publishing account B", () => {
    const store = getDefaultStore();
    const firstRevision = readIdentitySnapshot().revision + 1;
    replaceIdentitySnapshot(
      snapshot(firstRevision, session(SESSION_A, "user-a", 1))
    );
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-a", name: "Account A", role: "owner" },
    ]);
    store.set(org2CloudOrgsLoadedAtom, true);

    const observations: Array<{
      subject: string | null;
      orgCount: number;
    }> = [];
    const unsubscribe = store.sub(org2CloudAuthAtom, () => {
      observations.push({
        subject: store.get(org2CloudAuthAtom)?.userId ?? null,
        orgCount: store.get(org2CloudOrgsAtom).length,
      });
    });
    replaceIdentitySnapshot(
      snapshot(firstRevision + 1, session(SESSION_B, "user-b", 2))
    );
    unsubscribe();

    expect(store.get(org2CloudAuthAtom)?.userId).toBe("user-b");
    expect(store.get(org2CloudOrgsAtom)).toEqual([]);
    expect(store.get(org2CloudOrgsLoadedAtom)).toBe(false);
    expect(observations.at(-1)).toEqual({ subject: "user-b", orgCount: 0 });
  });
});
