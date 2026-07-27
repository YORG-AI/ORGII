export interface RuntimeInstanceProfile {
  instanceId: number;
  ideServerPort: number;
  cliProxyPort: number;
  authDeepLinkScheme: string;
}

const PRIMARY_IDE_SERVER_PORT = 13_847;
const PRIMARY_CLI_PROXY_PORT = 17_888;

/**
 * Resolve the runtime identity embedded by the per-instance Tauri config.
 * Keep these coordinates in parity with `scripts/tauri/instance-profile.cjs`
 * and `src-tauri/src/runtime_instance.rs`.
 */
export function runtimeInstanceProfileForIdentifier(
  identifier: string
): RuntimeInstanceProfile {
  const match = /^yorg\.orgii\.instance(\d+)$/.exec(identifier.trim());
  const parsedId = match ? Number(match[1]) : 1;
  const instanceId =
    Number.isInteger(parsedId) && parsedId >= 2 && parsedId <= 99
      ? parsedId
      : 1;

  return {
    instanceId,
    ideServerPort: PRIMARY_IDE_SERVER_PORT + instanceId - 1,
    cliProxyPort: PRIMARY_CLI_PROXY_PORT + instanceId - 1,
    authDeepLinkScheme:
      instanceId === 1 ? "orgii" : `orgii-instance${instanceId}`,
  };
}
