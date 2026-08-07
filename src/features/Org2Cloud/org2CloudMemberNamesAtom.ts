import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { getFreshCloudAccessToken } from "./cloudShortId";
import { listOrgMembers } from "./org2CloudClient";

const logger = createLogger("org2CloudMemberNames");

export const org2CloudMemberNamesAtom = atom<
  Record<string, Record<string, string>>
>({});
org2CloudMemberNamesAtom.debugLabel = "org2CloudMemberNamesAtom";

const inFlightOrgIds = new Set<string>();

export function resolveCloudMemberName(
  names: Record<string, Record<string, string>>,
  cloudOrgId: string,
  userId: string
): string | null {
  return names[cloudOrgId]?.[userId] ?? null;
}

export async function ensureCloudMemberNames(
  cloudOrgId: string
): Promise<void> {
  const store = getInstrumentedStore();
  if (store.get(org2CloudMemberNamesAtom)[cloudOrgId]) return;
  if (inFlightOrgIds.has(cloudOrgId)) return;
  inFlightOrgIds.add(cloudOrgId);
  try {
    const accessToken = await getFreshCloudAccessToken();
    if (!accessToken) return;
    const members = await listOrgMembers(accessToken, cloudOrgId);
    const byUserId: Record<string, string> = {};
    for (const member of members) {
      if (member.displayName) byUserId[member.userId] = member.displayName;
    }
    store.set(org2CloudMemberNamesAtom, (current) => ({
      ...current,
      [cloudOrgId]: byUserId,
    }));
  } catch (error) {
    logger.warn(`failed to load member roster for ${cloudOrgId}`, error);
  } finally {
    inFlightOrgIds.delete(cloudOrgId);
  }
}
