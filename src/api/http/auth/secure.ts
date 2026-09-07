import { type SupabaseTokenResponse, signOutSupabase } from "./supabase";
import "./supabase";

export type TokenResponse = SupabaseTokenResponse;

export async function secureClearTokens(): Promise<void> {
  await signOutSupabase();
}
