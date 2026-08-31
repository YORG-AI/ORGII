/**
 * Shared permission prompt helpers for desktop PermissionCard and mobile PermissionSheet.
 */

export interface PermissionArgPreview {
  key: string;
  value: string;
}

export interface PermissionPromptViewModel {
  label: string;
  commandText: string | null;
  description: string | null;
  argsPreview: PermissionArgPreview[];
}

const ARGS_PREVIEW_LIMIT = 5;
const ARG_VALUE_MAX_CHARS = 120;

export function buildPermissionArgsPreview(
  args: Record<string, unknown>
): PermissionArgPreview[] {
  return Object.entries(args)
    .slice(0, ARGS_PREVIEW_LIMIT)
    .map(([key, value]) => {
      const strValue =
        typeof value === "string" ? value : JSON.stringify(value);
      const truncated =
        strValue.length > ARG_VALUE_MAX_CHARS
          ? `${strValue.slice(0, ARG_VALUE_MAX_CHARS)}...`
          : strValue;
      return { key, value: truncated };
    });
}

export function resolvePermissionPromptViewModel(input: {
  tool: string;
  args: Record<string, unknown>;
  permissionPromptLabel: string;
  commandConfirmTitle: string;
}): PermissionPromptViewModel {
  const isCommandConfirm = input.tool === "exec:command-confirm";
  const command =
    isCommandConfirm && typeof input.args.command === "string"
      ? input.args.command
      : null;
  const reason =
    isCommandConfirm && typeof input.args.reason === "string"
      ? input.args.reason
      : null;

  return {
    label: isCommandConfirm
      ? input.commandConfirmTitle
      : input.permissionPromptLabel,
    commandText: command,
    description: reason,
    argsPreview: isCommandConfirm ? [] : buildPermissionArgsPreview(input.args),
  };
}
