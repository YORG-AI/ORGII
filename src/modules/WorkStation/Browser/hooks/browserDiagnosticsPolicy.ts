export function shouldEnableBrowserLogPolling(
  hostEnabled: boolean,
  nodeEnv: string | undefined
): boolean {
  return hostEnabled && nodeEnv !== "production";
}
