import type { CliSessionStatus } from "@src/types/session/session";

export function shouldShowSessionFailedBanner(
  runtimeStatus: CliSessionStatus | string
): boolean {
  return runtimeStatus === "failed";
}

export function shouldShowSessionInstallingBanner(
  runtimeStatus: CliSessionStatus | string
): boolean {
  return runtimeStatus === "installing";
}

export function shouldShowComposerActivityHud(input: {
  runtimeStatus: CliSessionStatus | string;
  hasStreamRetry: boolean;
}): boolean {
  if (input.hasStreamRetry) return false;
  if (shouldShowSessionFailedBanner(input.runtimeStatus)) return false;
  if (shouldShowSessionInstallingBanner(input.runtimeStatus)) return false;
  return true;
}

export function resolveSessionFailedBannerDescription(
  error: string | null | undefined,
  fallback: string
): string {
  const trimmed = error?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
