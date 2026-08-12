import { useAtom } from "jotai";
import { useCallback } from "react";
import { ZodError } from "zod";

import { refreshOrg2CloudAuthForAction } from "./org2CloudAuthAction";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { acceptCloudInvite, createCloudOrg } from "./org2CloudManagementClient";
import { parseCloudInviteInput } from "./org2CloudOrgManagement";
import {
  type Org2CloudOrg,
  useRefetchOrg2CloudOrgs,
} from "./org2CloudOrgsAtom";
import { ensureProjectOrgForCloudOrg } from "./org2CloudProjectOrgAlias";

export type CloudOrgMembershipActionError =
  | "signed_out"
  | "session_expired"
  | "session_superseded"
  | "session_unavailable"
  | "invalid_invite"
  | "unexpected_response"
  | "roster_not_converged";

export class CloudOrgMembershipActionFailure extends Error {
  constructor(readonly code: CloudOrgMembershipActionError) {
    super(code);
    this.name = "CloudOrgMembershipActionFailure";
  }
}

/**
 * One membership command boundary shared by onboarding and the regular
 * organization creator. Each command refreshes auth, commits exactly one
 * server mutation, then waits until the authoritative roster proves the
 * postcondition before returning success.
 */
export function useCloudOrgMembershipActions(): {
  createOrganization: (name: string) => Promise<Org2CloudOrg>;
  joinOrganization: (inviteInput: string) => Promise<Org2CloudOrg>;
} {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const refetchOrgs = useRefetchOrg2CloudOrgs();

  const withFreshAuth = useCallback(async () => {
    if (!auth) throw new CloudOrgMembershipActionFailure("signed_out");
    const refreshed = await refreshOrg2CloudAuthForAction(auth, setAuth);
    if (refreshed.status === "expired") {
      throw new CloudOrgMembershipActionFailure("session_expired");
    }
    if (refreshed.status === "superseded") {
      throw new CloudOrgMembershipActionFailure("session_superseded");
    }
    if (refreshed.status === "unavailable") {
      throw new CloudOrgMembershipActionFailure("session_unavailable");
    }
    return refreshed.auth;
  }, [auth, setAuth]);

  const createOrganization = useCallback(
    async (name: string): Promise<Org2CloudOrg> => {
      const trimmedName = name.trim();
      const fresh = await withFreshAuth();
      const { orgId } = await createCloudOrg(fresh.accessToken, trimmedName);
      try {
        await ensureProjectOrgForCloudOrg({ orgId, name: trimmedName });
      } catch {
        // The sync engine re-ensures this best-effort local alias per start.
      }
      const orgs = await refetchOrgs({
        until: (items) => items.some((item) => item.orgId === orgId),
      });
      const created = orgs.find((item) => item.orgId === orgId);
      if (!created) {
        throw new CloudOrgMembershipActionFailure("roster_not_converged");
      }
      return created;
    },
    [refetchOrgs, withFreshAuth]
  );

  const joinOrganization = useCallback(
    async (rawInvite: string): Promise<Org2CloudOrg> => {
      const inviteCode = parseCloudInviteInput(rawInvite);
      if (!inviteCode) {
        throw new CloudOrgMembershipActionFailure("invalid_invite");
      }
      const fresh = await withFreshAuth();
      let result: Awaited<ReturnType<typeof acceptCloudInvite>>;
      try {
        result = await acceptCloudInvite(fresh.accessToken, inviteCode);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new CloudOrgMembershipActionFailure("unexpected_response");
        }
        throw error;
      }
      const orgs = await refetchOrgs({
        until: (items) => items.some((item) => item.orgId === result.orgId),
      });
      const joined = orgs.find((item) => item.orgId === result.orgId);
      if (!joined) {
        throw new CloudOrgMembershipActionFailure("roster_not_converged");
      }
      try {
        await ensureProjectOrgForCloudOrg(joined);
      } catch {
        // The sync engine re-ensures this best-effort local alias per start.
      }
      return joined;
    },
    [refetchOrgs, withFreshAuth]
  );

  return { createOrganization, joinOrganization };
}
