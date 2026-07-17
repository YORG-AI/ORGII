/**
 * ORG2 Cloud endpoint configuration (design §8 + cloud-parity Phase C).
 *
 * ORG2 Cloud is ONE system with two ways to run it: the official managed
 * Supabase project (default) or the user's own deployment of the same stack
 * ("bring your own server"). The official URL/anon key are compile-time
 * constants; a custom endpoint is persisted as a zod-validated localStorage
 * override (`org2CloudEndpointOverrideAtom`) and resolved per call through
 * `getCloudEndpoint()` — every client builds its request URL/headers at
 * call time, so an endpoint switch takes effect WITHOUT an app reload.
 * (Switching still signs the user out: tokens, orgs, and cursors belong to
 * the old backend — see `resetCloudStateForEndpointSwitch`.)
 *
 * The anon (publishable) key is NOT a secret; row access is enforced
 * server-side by RLS + the user's JWT.
 */
import { z } from "zod/v4";

/** Official managed Supabase project (the default endpoint). */
export const ORG2_CLOUD_OFFICIAL_SUPABASE_URL =
  "https://fpdyejwbiriliuqqcjoy.supabase.co";

export const ORG2_CLOUD_OFFICIAL_ANON_KEY =
  "sb_publishable_FpHAgMYJFGb20HunqnhciA_-2nt9eYU";

/** Origin of the official ORG2 Cloud web app (login, billing, …). */
export const ORG2_CLOUD_OFFICIAL_WEB_ORIGIN =
  "https://org2-cloud-infra.vercel.app";

/** Deep link the login page redirects back to after the magic-link auth. */
export function buildCloudAuthCallbackUrl(
  configuredScheme = process.env.ORGII_DEEP_LINK_SCHEME ?? "orgii"
): string {
  const scheme = /^[a-z][a-z0-9+.-]*$/.test(configuredScheme)
    ? configuredScheme
    : "orgii";
  return `${scheme}://auth/callback`;
}

export const ORG2_CLOUD_AUTH_CALLBACK_URL = buildCloudAuthCallbackUrl();

/** PostgREST schema that hosts the cloud RPCs (`Content-Profile` header). */
export const ORG2_CLOUD_POSTGREST_SCHEMA = "org2_cloud";

/**
 * `org2_cloud.schema_version` this build speaks. Pre-release policy: the
 * backend ships as ONE consolidated baseline
 * (migrations/0001_org2_cloud_schema.sql, version 1) — schema changes fold
 * back into it and the dev project is rebuilt, so the version stays 1 until
 * the first public release. Sync against a CUSTOM endpoint is gated on an
 * exact match — the official endpoint is upgraded in lockstep with releases
 * and skips the gate.
 */
export const ORG2_CLOUD_EXPECTED_SCHEMA_VERSION = 1;

/** localStorage key of the custom-endpoint override (`null` = official). */
export const ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY =
  "orgii:org2-cloud-v1:endpointOverride";

/**
 * HTTPS absolute URL, with an explicit HTTP exception for loopback-only
 * development endpoints. A remote custom deployment must never downgrade
 * to cleartext, while local Supabase and self-hosted smoke tests need to run
 * without provisioning a fake certificate. Trailing slashes are stripped — consumers build paths as
 * `${url}/rest/v1/…`, so `https://x.supabase.co/` would otherwise put a
 * `//` into every request URL.
 */
const CloudEndpointUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return true;
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      );
    } catch {
      return false;
    }
  }, "https URL or loopback http URL required")
  .transform((value) => value.replace(/\/+$/, ""));

export const Org2CloudEndpointOverrideSchema = z.object({
  /** Origin of the deployment's web app (login, billing, …). */
  webOrigin: CloudEndpointUrlSchema,
  /** Supabase project URL (PostgREST + GoTrue live under it). */
  supabaseUrl: CloudEndpointUrlSchema,
  /** The deployment's anon (publishable) key. */
  anonKey: z.string().trim().min(1),
});

export type Org2CloudEndpointOverride = z.infer<
  typeof Org2CloudEndpointOverrideSchema
>;

export interface CloudEndpoint {
  webOrigin: string;
  supabaseUrl: string;
  anonKey: string;
  /** `false` ⇒ user-configured custom deployment ("bring your own server"). */
  isOfficial: boolean;
}

const OFFICIAL_ENDPOINT: CloudEndpoint = {
  webOrigin: ORG2_CLOUD_OFFICIAL_WEB_ORIGIN,
  supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  anonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
  isOfficial: true,
};

/**
 * Read the persisted override directly from localStorage — the SAME key and
 * schema `org2CloudEndpointOverrideAtom` writes through, so non-React code
 * (raw-fetch clients, the sync engine) resolves the endpoint without a store
 * reference. A missing, corrupted, or schema-incompatible value degrades to
 * `null` (official), mirroring the `createZodJsonStorage` posture.
 */
function readEndpointOverride(): Org2CloudEndpointOverride | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
  if (raw === null) return null;
  try {
    return Org2CloudEndpointOverrideSchema.nullable().parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Resolve the active cloud endpoint: the persisted custom override when one
 * is set, otherwise the official managed project. Resolved fresh on every
 * call — callers must not cache the result across requests.
 */
export function getCloudEndpoint(): CloudEndpoint {
  const override = readEndpointOverride();
  if (!override) return OFFICIAL_ENDPOINT;
  return { ...override, isOfficial: false };
}

/** Build the browser login URL with the desktop deep-link return target. */
export function buildOrg2CloudLoginUrl(): string {
  const url = new URL("/login", getCloudEndpoint().webOrigin);
  url.searchParams.set("return_to", ORG2_CLOUD_AUTH_CALLBACK_URL);
  return url.toString();
}

/**
 * Same-origin web path of the billing page. Used as the web login return
 * target (see buildCloudBillingLoginUrl); it
 * must stay a plain relative path so the web app's `isSafeWebReturnTo` guard
 * accepts it.
 */
export const CLOUD_BILLING_PATH = "/billing";

/**
 * Billing uses an independent web session (the system browser's). Sharing
 * the desktop refresh token with another long-lived consumer creates two
 * rotating consumers and eventually invalidates one of them. The web login
 * owns its cookie/refresh lifecycle and returns to billing without ever
 * receiving desktop credentials.
 */
export function buildCloudBillingLoginUrl(): string {
  const url = new URL("/login", getCloudEndpoint().webOrigin);
  url.searchParams.set("return_to", CLOUD_BILLING_PATH);
  return url.toString();
}
