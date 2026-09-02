import {
  type Session,
  type SupabaseClient,
  createClient,
} from "@supabase/supabase-js";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "@src/features/Org2Cloud/config";

import type { MobileAuthSession } from "./mobileAuthState";

const SERVER_SESSION_PATH = "/v1/mobile/auth/session";
const EXPIRY_SKEW_SECONDS = 60;

export class MobileAuthClientError extends Error {
  constructor(
    message: string,
    readonly retryable = true
  ) {
    super(message);
    this.name = "MobileAuthClientError";
  }
}

export interface MobileAuthClient {
  buildLoginUrl(callbackUrl: string): Promise<string>;
  exchangeCallback(callbackUrl: string): Promise<MobileAuthSession>;
  restoreSession(
    stored: MobileAuthSession,
    options?: { forceRefresh?: boolean }
  ): Promise<MobileAuthSession>;
  establishServerSession(accessToken: string): Promise<void>;
  signOut(session: MobileAuthSession | null): Promise<void>;
}

function isPermanentStatus(status: unknown): boolean {
  return status === 400 || status === 401 || status === 403;
}

function toClientError(error: unknown): MobileAuthClientError {
  if (error instanceof MobileAuthClientError) return error;
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; status?: unknown };
    return new MobileAuthClientError(
      typeof record.message === "string"
        ? record.message
        : "Authentication failed",
      !isPermanentStatus(record.status)
    );
  }
  return new MobileAuthClientError(
    error instanceof Error ? error.message : "Authentication failed"
  );
}

function profileFromSession(
  session: Session,
  previous?: MobileAuthSession["profile"]
): MobileAuthSession["profile"] {
  const metadata = session.user.user_metadata ?? {};
  const displayName =
    typeof metadata.full_name === "string"
      ? metadata.full_name
      : typeof metadata.name === "string"
        ? metadata.name
        : previous?.displayName;
  const primaryEmail = session.user.email ?? previous?.primaryEmail;
  const avatarUrl =
    typeof metadata.avatar_url === "string"
      ? metadata.avatar_url
      : previous?.avatarUrl;
  return displayName || primaryEmail || avatarUrl
    ? { displayName, primaryEmail, avatarUrl }
    : undefined;
}

function toMobileSession(
  session: Session,
  previous?: MobileAuthSession
): MobileAuthSession {
  const expiresAt = session.expires_at;
  if (!expiresAt || !session.user.id) {
    throw new MobileAuthClientError(
      "Authentication response is incomplete",
      false
    );
  }
  return {
    kind: "org2_cloud",
    supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
    supabaseAnonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
    userId: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt,
    profile: profileFromSession(session, previous?.profile),
  };
}

function createOfficialClient(): SupabaseClient {
  return createClient(
    ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
    ORG2_CLOUD_OFFICIAL_ANON_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        // Supabase only honors the supplied storage adapter when session
        // persistence is enabled. PKCE needs that adapter across the OAuth
        // redirect so the callback can recover its code verifier.
        persistSession: true,
        flowType: "pkce",
        storage:
          typeof sessionStorage === "undefined" ? undefined : sessionStorage,
      },
    }
  );
}

export function createMobileAuthClient(): MobileAuthClient {
  const supabase = createOfficialClient();

  return {
    async buildLoginUrl(callbackUrl) {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: {
          redirectTo: callbackUrl,
          skipBrowserRedirect: true,
          scopes: "read:user user:email",
        },
      });
      if (error || !data.url) throw toClientError(error);
      return data.url;
    },

    async exchangeCallback(callbackUrl) {
      try {
        const parsed = new URL(callbackUrl);
        const code = parsed.searchParams.get("code")?.trim();
        if (!code || parsed.hash) {
          throw new MobileAuthClientError(
            "Authentication callback is incomplete",
            false
          );
        }
        const result = await supabase.auth.exchangeCodeForSession(code);
        if (result.error || !result.data.session) {
          throw toClientError(result.error);
        }
        return toMobileSession(result.data.session);
      } catch (error) {
        throw toClientError(error);
      }
    },

    async restoreSession(stored, options) {
      if (
        stored.supabaseUrl !== ORG2_CLOUD_OFFICIAL_SUPABASE_URL ||
        stored.supabaseAnonKey !== ORG2_CLOUD_OFFICIAL_ANON_KEY
      ) {
        throw new MobileAuthClientError(
          "This session belongs to a different ORG2 Cloud endpoint",
          false
        );
      }
      try {
        const shouldRefresh =
          options?.forceRefresh === true ||
          stored.expiresAt <= Date.now() / 1_000 + EXPIRY_SKEW_SECONDS;
        const result = shouldRefresh
          ? await supabase.auth.refreshSession({
              refresh_token: stored.refreshToken,
            })
          : await supabase.auth.setSession({
              access_token: stored.accessToken,
              refresh_token: stored.refreshToken,
            });
        if (result.error || !result.data.session) {
          throw toClientError(result.error);
        }
        return toMobileSession(result.data.session, stored);
      } catch (error) {
        throw toClientError(error);
      }
    },

    async establishServerSession(accessToken) {
      let response: Response;
      try {
        response = await fetch(SERVER_SESSION_PATH, {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (error) {
        throw toClientError(error);
      }
      if (!response.ok) {
        throw new MobileAuthClientError(
          `Mobile session exchange failed (${response.status})`,
          !isPermanentStatus(response.status)
        );
      }
    },

    async signOut(session) {
      await fetch(SERVER_SESSION_PATH, {
        method: "DELETE",
        credentials: "include",
      }).catch(() => undefined);
      if (session) {
        await supabase.auth
          .setSession({
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
          })
          .catch(() => undefined);
      }
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    },
  };
}

export function isRetryableMobileAuthError(error: unknown): boolean {
  return !(error instanceof MobileAuthClientError) || error.retryable;
}
