import { invoke, isTauri } from "@tauri-apps/api/core";

import { isIdentityBrokerEnabled } from "./identityConfig";
import {
  BeginIdentitySignInOutcomeSchema,
  HostedServiceAccessLeaseSchema,
  IdentitySnapshotSchema,
  LegacyIdentityImportOutcomeSchema,
  Org2CloudAccessLeaseSchema,
  createEmptyIdentitySnapshot,
} from "./identityTypes";
import type {
  BeginIdentitySignInOutcome,
  HostedServiceAccessLease,
  IdentityRealm,
  IdentitySnapshot,
  LegacyIdentityImportOutcome,
  Org2CloudAccessLease,
} from "./identityTypes";

async function invokeSnapshot(
  command: string,
  args?: Record<string, unknown>
): Promise<IdentitySnapshot> {
  const payload = await invoke<unknown>(command, args);
  return IdentitySnapshotSchema.parse(payload);
}

class IdentityClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IdentityClientError";
  }
}

export const identityClient = {
  async beginOrg2CloudSignIn(input: {
    webOrigin: string;
    supabaseUrl: string;
    publicClientKey: string;
  }): Promise<BeginIdentitySignInOutcome> {
    if (!isIdentityBrokerEnabled || !isTauri()) {
      throw new Error("Native identity broker is unavailable");
    }
    const payload = await invoke<unknown>("identity_begin_org2_cloud_sign_in", {
      input,
    });
    return BeginIdentitySignInOutcomeSchema.parse(payload);
  },

  async beginHostedServiceSignIn(input: {
    supabaseUrl: string;
    publicClientKey: string;
    redirectUri: string;
    provider: string;
    scopes: string;
  }): Promise<BeginIdentitySignInOutcome> {
    if (!isIdentityBrokerEnabled || !isTauri()) {
      throw new IdentityClientError("identity_broker_unavailable");
    }
    const payload = await invoke<unknown>(
      "identity_begin_hosted_service_sign_in",
      { input }
    );
    return BeginIdentitySignInOutcomeSchema.parse(payload);
  },

  async completeHostedServiceSignIn(code: string): Promise<IdentitySnapshot> {
    if (!isIdentityBrokerEnabled || !isTauri()) {
      throw new IdentityClientError("identity_broker_unavailable");
    }
    return invokeSnapshot("identity_complete_hosted_service_sign_in", {
      input: { code },
    });
  },

  async getSnapshot(): Promise<IdentitySnapshot> {
    if (!isIdentityBrokerEnabled || !isTauri())
      return createEmptyIdentitySnapshot();
    return invokeSnapshot("identity_get_snapshot");
  },

  async getOrg2CloudAccessLease(input: {
    sessionId: string;
    generation: number;
  }): Promise<Org2CloudAccessLease> {
    if (!isIdentityBrokerEnabled || !isTauri()) {
      throw new IdentityClientError("identity_broker_unavailable");
    }
    const payload = await invoke<unknown>(
      "identity_get_org2_cloud_access_lease",
      {
        input: { ...input, audience: "org2_cloud_api" },
      }
    );
    return Org2CloudAccessLeaseSchema.parse(payload);
  },

  async getHostedServiceAccessLease(input: {
    sessionId: string;
    generation: number;
  }): Promise<HostedServiceAccessLease> {
    if (!isIdentityBrokerEnabled || !isTauri()) {
      throw new IdentityClientError("identity_broker_unavailable");
    }
    const payload = await invoke<unknown>(
      "identity_get_hosted_service_access_lease",
      {
        input: { ...input, audience: "hosted_service_api" },
      }
    );
    return HostedServiceAccessLeaseSchema.parse(payload);
  },

  async retryRestore(): Promise<IdentitySnapshot> {
    if (!isIdentityBrokerEnabled || !isTauri())
      return createEmptyIdentitySnapshot();
    return invokeSnapshot("identity_retry_restore");
  },

  async importLegacyCloudIdentity(): Promise<LegacyIdentityImportOutcome | null> {
    if (!isIdentityBrokerEnabled || !isTauri()) return null;
    const payload = await invoke<unknown>("identity_migrate_legacy_org2_cloud");
    return payload === null
      ? null
      : LegacyIdentityImportOutcomeSchema.parse(payload);
  },

  async signOut(
    realm: IdentityRealm,
    sessionId?: string
  ): Promise<IdentitySnapshot> {
    if (!isIdentityBrokerEnabled || !isTauri())
      return createEmptyIdentitySnapshot();
    return invokeSnapshot("identity_sign_out", {
      input: { realm, sessionId },
    });
  },
};

export function getIdentityErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}
