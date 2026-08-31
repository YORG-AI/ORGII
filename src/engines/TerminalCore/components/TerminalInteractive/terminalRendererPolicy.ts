interface TerminalRendererEnvironment {
  processPlatform?: string;
  userAgent?: string;
}

function currentRendererEnvironment(): TerminalRendererEnvironment {
  return {
    processPlatform:
      typeof process !== "undefined" ? process.platform : undefined,
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  };
}

export function shouldLoadTerminalWebgl(
  environment: TerminalRendererEnvironment = currentRendererEnvironment()
): boolean {
  const platform = environment.processPlatform?.toLowerCase() ?? "";
  const userAgent = environment.userAgent?.toLowerCase() ?? "";
  const isLinux =
    platform === "linux" ||
    (userAgent.includes("linux") && !userAgent.includes("android"));

  return !isLinux;
}
