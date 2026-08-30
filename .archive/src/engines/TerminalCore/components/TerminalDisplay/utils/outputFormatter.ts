/**
 * Terminal Output Formatting Utilities
 *
 * Extracted from RunCommand to eliminate duplication.
 * Handles directory tree formatting and output string extraction.
 */

/**
 * Format directory tree structure for terminal display
 * Converts backend directoryTreeRoot structure to ASCII tree
 *
 * @param output - Backend output object containing directoryTreeRoot
 * @returns Formatted ASCII tree string
 */
export function formatDirectoryTree(output: unknown): string {
  if (!output || typeof output !== "object") return String(output || "");

  const outputObj = output as Record<string, unknown>;

  // Handle Ls event output format: { success: { directoryTreeRoot: {...} } }
  const successObj = outputObj.success as Record<string, unknown> | undefined;
  const treeRoot =
    (successObj?.directoryTreeRoot as Record<string, unknown> | undefined) ||
    (outputObj.directoryTreeRoot as Record<string, unknown> | undefined);

  if (!treeRoot) {
    // Fallback: stringify if it's some other object
    return JSON.stringify(output, null, 2);
  }

  const lines: string[] = [];

  function formatNode(
    node: Record<string, unknown>,
    prefix: string = "",
    isLast: boolean = true
  ): void {
    const absPath = node.absPath as string | undefined;
    const nodeName = node.name as string | undefined;
    const baseName = absPath?.split("/").pop() || nodeName || "";
    const connector = isLast ? "└── " : "├── ";
    const isDir = node.childrenDirs || node.childrenFiles;

    if (baseName) {
      lines.push(`${prefix}${connector}${baseName}${isDir ? "/" : ""}`);
    } else if (absPath) {
      // Root node
      lines.push(absPath + "/");
    }

    const childPrefix = prefix + (isLast ? "    " : "│   ");

    // Add directories first
    const dirs = (node.childrenDirs as Record<string, unknown>[]) || [];
    const files = (node.childrenFiles as Record<string, unknown>[]) || [];
    const totalChildren = dirs.length + files.length;

    dirs.forEach((dir: Record<string, unknown>, idx: number) => {
      formatNode(
        dir,
        baseName ? childPrefix : "",
        idx === totalChildren - 1 && files.length === 0
      );
    });

    // Add files
    files.forEach((file: Record<string, unknown>, idx: number) => {
      const fileConnector = idx === files.length - 1 ? "└── " : "├── ";
      const fileName = file.name as string | undefined;
      lines.push(
        `${baseName ? childPrefix : ""}${fileConnector}${fileName || ""}`
      );
    });
  }

  formatNode(treeRoot);
  return lines.join("\n");
}

/**
 * Get output as string from various backend formats
 * Handles multiple output structures and extracts the actual content
 *
 * @param output - Backend output in various formats
 * @returns Output content as string
 */
export function getOutputAsString(output: unknown): string {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (typeof output !== "object") return String(output);

  const outputObj = output as Record<string, unknown>;

  // Check if it's a directory tree structure (Ls event)
  const successObj = outputObj.success as Record<string, unknown> | undefined;
  if (successObj?.directoryTreeRoot || outputObj.directoryTreeRoot) {
    return formatDirectoryTree(output);
  }

  // Check if it's a shell command output format: { success: { stdout, interleavedOutput, ... } }
  if (successObj) {
    // Prefer interleavedOutput (combines stdout and stderr), then stdout
    if (successObj.interleavedOutput !== undefined) {
      return String(successObj.interleavedOutput);
    }
    if (successObj.stdout !== undefined) {
      return String(successObj.stdout);
    }
    if (successObj.content !== undefined) {
      return String(successObj.content);
    }
  }

  // Fallback: stringify the object
  return JSON.stringify(output, null, 2);
}

/**
 * Extract command string from various result formats
 * Backend sends commands in different nested structures
 *
 * @param result - Backend result object
 * @param args - Backend args object (fallback source)
 * @returns Extracted command string
 */
export function extractCommandFromResult(
  result: unknown,
  args: unknown
): string {
  if (!result || typeof result !== "object") return "";

  const resultObj = result as Record<string, unknown>;
  const outputObj = resultObj.output as Record<string, unknown> | undefined;
  const successObj = outputObj?.success as Record<string, unknown> | undefined;
  const resultSuccessObj = resultObj.success as
    | Record<string, unknown>
    | undefined;
  const argsObj = args as Record<string, unknown> | undefined;

  // Check result.output.success.command (backend shell format)
  if (successObj?.command) {
    return String(successObj.command);
  }
  // Check result.success.command
  if (resultSuccessObj?.command) {
    return String(resultSuccessObj.command);
  }
  // Check result.command
  if (resultObj.command) {
    return String(resultObj.command);
  }
  // Check args.command
  if (argsObj?.command) {
    return String(argsObj.command);
  }
  return "";
}

/**
 * Remove backticks from command strings
 * Backend sometimes wraps commands in backticks
 *
 * @param cmd - Command string that may contain backticks
 * @returns Cleaned command string
 */
export function removeBackticks(cmd: string): string {
  return cmd?.replace(/`/g, "") || "";
}

/**
 * Extract exit code from various result formats
 *
 * @param result - Backend result object
 * @returns Exit code or undefined
 */
export function extractExitCode(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined;

  const resultObj = result as Record<string, unknown>;
  const outputObj = resultObj.output as Record<string, unknown> | undefined;
  const successObj = outputObj?.success as Record<string, unknown> | undefined;
  const resultSuccessObj = resultObj.success as
    | Record<string, unknown>
    | undefined;

  // Check result.output.success.exitCode
  if (successObj?.exitCode !== undefined) {
    return successObj.exitCode as number;
  }
  // Check result.success.exitCode
  if (resultSuccessObj?.exitCode !== undefined) {
    return resultSuccessObj.exitCode as number;
  }
  // Check result.exitCode
  if (resultObj.exitCode !== undefined) {
    return resultObj.exitCode as number;
  }

  return undefined;
}

/**
 * Extract stderr from various result formats
 *
 * @param result - Backend result object
 * @returns Stderr content or empty string
 */
export function extractStderr(result: unknown): string {
  if (!result || typeof result !== "object") return "";

  const resultObj = result as Record<string, unknown>;
  const outputObj = resultObj.output as Record<string, unknown> | undefined;
  const successObj = outputObj?.success as Record<string, unknown> | undefined;
  const resultSuccessObj = resultObj.success as
    | Record<string, unknown>
    | undefined;

  // Check result.output.success.stderr
  if (successObj?.stderr) {
    return String(successObj.stderr);
  }
  // Check result.success.stderr
  if (resultSuccessObj?.stderr) {
    return String(resultSuccessObj.stderr);
  }
  // Check result.stderr
  if (resultObj.stderr) {
    return String(resultObj.stderr);
  }

  return "";
}
