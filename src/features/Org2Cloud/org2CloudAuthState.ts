import { z } from "zod/v4";

export const Org2CloudProfileSchema = z.object({
  displayName: z.string().optional(),
  primaryEmail: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export type Org2CloudProfile = z.infer<typeof Org2CloudProfileSchema>;

/** Browser-safe canonical shape shared by desktop and standalone clients. */
export const Org2CloudAuthStateSchema = z.object({
  kind: z.literal("org2_cloud"),
  supabaseUrl: z.string(),
  supabaseAnonKey: z.string(),
  userId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access-token expiry, unix epoch seconds. */
  expiresAt: z.number(),
  profile: Org2CloudProfileSchema.optional(),
});

export type Org2CloudAuthState = z.infer<typeof Org2CloudAuthStateSchema>;

const StoredAuthSchema = Org2CloudAuthStateSchema.nullable();

/** Parse the canonical serialized representation without importing Tauri state. */
export function parseStoredOrg2CloudAuth(
  raw: string | null
): Org2CloudAuthState | null {
  if (raw === null) return null;
  return StoredAuthSchema.parse(JSON.parse(raw));
}
