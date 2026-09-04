import type { SupportedStorage } from "@supabase/supabase-js";

import type { MobileAuthClient } from "../../auth/mobileAuthClient";
import {
  type SupabaseMobileAuthClientOptions,
  createSupabaseMobileAuthClient,
} from "../supabaseMobileAuthClient";

export type BrowserMobileAuthClientOptions = Pick<
  SupabaseMobileAuthClientOptions,
  "oauthStorage" | "fetcher"
> & {
  oauthStorage: SupportedStorage;
};

/** Browser binding retained for compatibility; OAuth behavior is shared. */
export function createBrowserMobileAuthClient(
  options: BrowserMobileAuthClientOptions
): MobileAuthClient {
  return createSupabaseMobileAuthClient(options);
}
