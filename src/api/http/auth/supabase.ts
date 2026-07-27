import {
  type Session,
  type SupabaseClient,
  createClient,
} from "@supabase/supabase-js";

import {
  SERVICE_AUTH_CONFIG,
  clearHostedToken,
  getCallbackUrl,
  isTauriRuntime,
  storeHostedToken,
  storeHostedUserId,
} from "@src/config/serviceAuth";

import {
  SUPABASE_AUTH_STORAGE_KEY,
  sharedServiceAuthStorage,
} from "./sharedAuthStorage";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

let supabaseClient: SupabaseClient | null = null;

function ensureSupabaseConfig(): void {
  if (
    !SERVICE_AUTH_CONFIG.supabaseUrl ||
    !SERVICE_AUTH_CONFIG.supabasePublishableKey
  ) {
    throw new Error(
      "Supabase auth is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_PUBLISHABLE_KEY."
    );
  }
}

export function getSupabaseAuthClient(): SupabaseClient {
  ensureSupabaseConfig();

  if (!supabaseClient) {
    supabaseClient = createClient(
      SERVICE_AUTH_CONFIG.supabaseUrl,
      SERVICE_AUTH_CONFIG.supabasePublishableKey,
      {
        auth: {
          flowType: "pkce",
          persistSession: true,
          // useServiceAuth owns refresh timing. Keeping Supabase's internal
          // ticker off avoids a shared-file read every 30 seconds while idle.
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: SUPABASE_AUTH_STORAGE_KEY,
          storage: sharedServiceAuthStorage,
        },
      }
    );
  }

  return supabaseClient;
}

export function syncHostedTokenFromSession(session: Session): TokenResponse {
  storeHostedToken(
    session.access_token,
    session.expires_in,
    session.refresh_token
  );
  storeHostedUserId(session.user.id);

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: session.token_type,
    expires_in: session.expires_in,
  };
}

export async function signInWithSupabase(): Promise<void> {
  const supabase = getSupabaseAuthClient();
  const tauriRuntime = isTauriRuntime();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: SERVICE_AUTH_CONFIG.oauthProvider,
    options: {
      redirectTo: getCallbackUrl(),
      scopes: SERVICE_AUTH_CONFIG.oauthScopes,
      skipBrowserRedirect: tauriRuntime,
    },
  });

  if (error) {
    throw error;
  }

  if (tauriRuntime && data.url) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(data.url);
  }
}

export async function exchangeSupabaseCodeForSession(
  code: string
): Promise<TokenResponse> {
  const supabase = getSupabaseAuthClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    throw error;
  }
  if (!data.session) {
    throw new Error("Supabase did not return an authenticated session.");
  }

  return syncHostedTokenFromSession(data.session);
}

export async function getSupabaseHostedToken(): Promise<string | null> {
  const supabase = getSupabaseAuthClient();
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    throw error;
  }
  if (!data.session) {
    return null;
  }

  syncHostedTokenFromSession(data.session);
  return data.session.access_token;
}

export async function refreshSupabaseSession(): Promise<TokenResponse> {
  const supabase = getSupabaseAuthClient();
  const { data, error } = await supabase.auth.refreshSession();

  if (error) {
    throw error;
  }
  if (!data.session) {
    throw new Error("Supabase did not return a refreshed session.");
  }

  return syncHostedTokenFromSession(data.session);
}

export async function signOutSupabase(): Promise<void> {
  const supabase = getSupabaseAuthClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    throw error;
  }

  clearHostedToken();
}

export type { TokenResponse as SupabaseTokenResponse };
