/**
 * Scope-neutral discussion-channel contract shared by the local and cloud
 * planes. Keeping these rules outside `Org2Cloud` prevents the local store and
 * dialogs from depending on a transport-specific feature boundary.
 */

/** Mirrored by the 0014 cloud RPC validation. */
export const CHANNEL_NAME_MAX_LENGTH = 80;
export const CHANNEL_TOPIC_MAX_LENGTH = 250;
export const CHANNEL_MAX_ACTIVE_PER_SCOPE = 200;

/** Live-typing normalization: what the create dialog stores per keystroke. */
export function normalizeChannelNameInput(raw: string): string {
  return raw
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .slice(0, CHANNEL_NAME_MAX_LENGTH);
}

/** Submit-time normalization: also drops edge hyphens left by typing. */
export function normalizeChannelName(raw: string): string {
  return normalizeChannelNameInput(raw.trim()).replace(/^-+|-+$/g, "");
}

export type ChannelNameError = "empty" | "tooLong" | "whitespace";

/** Validates an already-normalized name against the server contract. */
export function validateChannelName(name: string): ChannelNameError | null {
  if (name.length === 0) return "empty";
  if (name.length > CHANNEL_NAME_MAX_LENGTH) return "tooLong";
  if (/\s/.test(name) || name.startsWith("#")) return "whitespace";
  return null;
}
