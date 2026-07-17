/**
 * Pure matching for the `orgii://billing/complete` deep link — the billing
 * success page navigates here after Stripe confirms the paid plan (in the
 * system browser the OS routes it to the app). Kept free of React / Jotai /
 * Tauri imports so it can be unit tested in isolation — mirrors
 * `authCallback.ts`.
 */

export const ORG2_CLOUD_BILLING_DEEP_LINK_HOST = "billing";
export const ORG2_CLOUD_BILLING_DEEP_LINK_PATH = "complete";

export function isBillingCompleteDeepLink(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("orgii://")) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return (
      host === ORG2_CLOUD_BILLING_DEEP_LINK_HOST &&
      path === ORG2_CLOUD_BILLING_DEEP_LINK_PATH
    );
  } catch {
    return false;
  }
}
