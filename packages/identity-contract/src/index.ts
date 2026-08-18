import { z } from "zod/v4";

/** Package-level contract revision. The current wire remains snapshot v1. */
export const IDENTITY_CONTRACT_VERSION = 1 as const;

export const IdentityRealmSchema = z.enum([
  "org2_cloud",
  "hosted_service_legacy",
  "cloud_web",
  "remote_workspace",
]);
export type IdentityRealm = z.infer<typeof IdentityRealmSchema>;

export const IdentitySessionStatusSchema = z.enum([
  "restoring",
  "ready",
  "offline_degraded",
  "reauth_required",
  "signing_out",
]);
export type IdentitySessionStatus = z.infer<typeof IdentitySessionStatusSchema>;

export const SecureStoreStatusSchema = z.enum([
  "available",
  "locked",
  "unavailable",
]);
export type SecureStoreStatus = z.infer<typeof SecureStoreStatusSchema>;

export const SignInFlowSchema = z
  .object({
    flowId: z.string(),
    realm: IdentityRealmSchema,
    phase: z.enum([
      "preparing",
      "browser_open",
      "awaiting_callback",
      "exchanging_code",
      "verifying_session",
      "failed",
    ]),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type SignInFlow = z.infer<typeof SignInFlowSchema>;

export const IdentitySessionSchema = z
  .object({
    sessionId: z.uuid(),
    realm: IdentityRealmSchema,
    issuer: z.url(),
    subject: z.string().min(1),
    displayName: z.string().nullable().optional(),
    primaryEmail: z.string().nullable().optional(),
    avatarUrl: z.string().nullable().optional(),
    scopes: z.array(z.string()),
    expiresAtUnix: z.number().int().nullable().optional(),
    status: IdentitySessionStatusSchema,
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type IdentitySession = z.infer<typeof IdentitySessionSchema>;

export const IdentitySnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sessions: z.array(IdentitySessionSchema),
    activeSessions: z.partialRecord(IdentityRealmSchema, z.uuid()),
    flows: z.array(SignInFlowSchema),
    secureStoreStatus: SecureStoreStatusSchema,
  })
  .strict();
export type IdentitySnapshot = z.infer<typeof IdentitySnapshotSchema>;
