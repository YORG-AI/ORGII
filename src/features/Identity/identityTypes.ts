import { z } from "zod/v4";

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

export const BeginIdentitySignInOutcomeSchema = z
  .object({
    flowId: z.uuid(),
    snapshot: IdentitySnapshotSchema,
  })
  .strict();
export type BeginIdentitySignInOutcome = z.infer<
  typeof BeginIdentitySignInOutcomeSchema
>;

export const LegacyIdentityImportOutcomeSchema = z
  .object({
    snapshot: IdentitySnapshotSchema,
    stage: z.literal("credential_imported"),
    alreadyImported: z.boolean(),
    legacySecretCanBeDeleted: z.boolean(),
  })
  .strict();
export type LegacyIdentityImportOutcome = z.infer<
  typeof LegacyIdentityImportOutcomeSchema
>;

export const IdentityInvalidationSchema = z
  .object({
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const Org2CloudAccessLeaseSchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.number().int().nonnegative(),
    issuer: z.url(),
    publicClientKey: z.string().min(1),
    subject: z.string().min(1),
    expiresAtUnix: z.number().int().positive(),
    audience: z.literal("org2_cloud_api"),
    accessToken: z.string().min(1),
  })
  .strict();
export type Org2CloudAccessLease = z.infer<typeof Org2CloudAccessLeaseSchema>;

export const HostedServiceAccessLeaseSchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.number().int().nonnegative(),
    issuer: z.url(),
    publicClientKey: z.string().min(1),
    subject: z.string().min(1),
    expiresAtUnix: z.number().int().positive(),
    audience: z.literal("hosted_service_api"),
    accessToken: z.string().min(1),
  })
  .strict();
export type HostedServiceAccessLease = z.infer<
  typeof HostedServiceAccessLeaseSchema
>;

export function createEmptyIdentitySnapshot(): IdentitySnapshot {
  return {
    revision: 0,
    sessions: [],
    activeSessions: {},
    flows: [],
    secureStoreStatus: "unavailable",
  };
}

export function getActiveIdentitySession(
  snapshot: IdentitySnapshot,
  realm: IdentityRealm
): IdentitySession | null {
  const activeId = snapshot.activeSessions[realm];
  if (!activeId) return null;
  return (
    snapshot.sessions.find(
      (session) => session.realm === realm && session.sessionId === activeId
    ) ?? null
  );
}
