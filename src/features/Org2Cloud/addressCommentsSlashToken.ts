export const ADDRESS_COMMENTS_SLASH_TOKEN = "address-comments";

export function buildAddressCommentsPillPath(
  selectedHeadIds: readonly string[]
): string {
  return `/${ADDRESS_COMMENTS_SLASH_TOKEN}:${selectedHeadIds.join(",")}`;
}

export interface AddressCommentsSlashCommandDraft {
  selectedHeadIds?: string[];
  instruction?: string;
}

const PILL_PATTERN = new RegExp(
  `\\[skill:\\/${ADDRESS_COMMENTS_SLASH_TOKEN}(?::([^\\]]*))?\\]`,
  "i"
);
const PLAIN_PATTERN = new RegExp(
  `^\\/${ADDRESS_COMMENTS_SLASH_TOKEN}(?:\\s+([\\s\\S]+))?$`,
  "i"
);

export function parseAddressCommentsSlashCommand(
  text: string
): AddressCommentsSlashCommandDraft | null {
  const trimmed = text.trim();

  const pillMatch = PILL_PATTERN.exec(trimmed);
  if (pillMatch) {
    const ids = (pillMatch[1] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const instruction = trimmed
      .slice((pillMatch.index ?? 0) + pillMatch[0].length)
      .trim();
    return {
      ...(ids.length > 0 ? { selectedHeadIds: ids } : {}),
      ...(instruction ? { instruction } : {}),
    };
  }

  const plainMatch = PLAIN_PATTERN.exec(trimmed);
  if (!plainMatch) return null;
  const instruction = plainMatch[1]?.trim();
  return instruction ? { instruction } : {};
}
