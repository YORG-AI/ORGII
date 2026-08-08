/**
 * The channel post handler, factored out of the view so it can be tested
 * without driving `InputArea`'s contenteditable editor.
 *
 * `InputArea` submits through `onSubmitOverride` (see `useSubmitMessage`), and
 * that contract is NOT "return false on failure":
 *
 *  - resolving `true`  → handled; the composer does not fall through to the
 *    agent submit path (which a channel has no business reaching).
 *  - THROWING          → the send failed; `useSubmitMessage` restores the
 *    editor snapshot it captured before the optimistic clear.
 *
 * So a refused post must throw. That is what keeps the draft on screen the way
 * the old hand-rolled textarea did by returning `false`.
 */
import type { SubmitOverrideInput } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { org2ChannelMessagesErrorCode } from "@src/features/Org2Cloud/channels/channelMessagesClient";
import { CHANNEL_MESSAGE_MAX_LENGTH } from "@src/features/Org2Cloud/channels/channelMessagesTypes";
import type {
  LocalChannelMessageErrorCode,
  LocalChannelMessageResult,
} from "@src/store/ui/localChannelMessagesAtom";

/** Refusal code → `navigation` namespace key. */
export const CHANNEL_POST_ERROR_KEYS: Record<
  LocalChannelMessageErrorCode,
  string
> = {
  empty: "cloud.channels.feed.errorEmpty",
  tooLong: "cloud.channels.feed.errorTooLong",
  quota: "cloud.channels.feed.errorQuota",
  invalid: "cloud.channels.feed.errorGeneric",
};

export interface ChannelPostHandlerDeps {
  /** Writes the post; the local message store's reducer result. */
  post: (body: string) => LocalChannelMessageResult;
  /** Localizes a refusal key from `CHANNEL_POST_ERROR_KEYS`. */
  translate: (key: string) => string;
  /** Publishes the inline refusal copy; called with `null` on success. */
  onError: (message: string | null) => void;
}

export type ChannelPostHandler = (
  input: SubmitOverrideInput
) => Promise<boolean>;

/**
 * Builds the `onSubmitOverride` a channel composer hands to `InputArea`.
 *
 * Whitespace-only submits resolve `true` without touching the store: the
 * composer already refuses to send an empty editor, and reporting `empty` back
 * as an error would flash a message the user never caused.
 */
export function createChannelPostHandler(
  deps: ChannelPostHandlerDeps
): ChannelPostHandler {
  const { post, translate, onError } = deps;
  return async ({ displayText }: SubmitOverrideInput): Promise<boolean> => {
    const body = displayText.trim();
    if (body.length === 0) return true;

    const result = post(body);
    if (result.ok) {
      onError(null);
      return true;
    }

    const message = translate(CHANNEL_POST_ERROR_KEYS[result.error]);
    onError(message);
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Cloud scope
// ---------------------------------------------------------------------------

/**
 * Server refusal code → `navigation` namespace key. Every entry is copy the
 * user can ACT on: "only managers can post here", "this channel is archived".
 * Anything unlisted (transport failure, an unrecognized future code) falls
 * back to the generic post error the local plane already uses.
 */
export const CLOUD_CHANNEL_POST_ERROR_KEYS: Record<string, string> = {
  ORG2_CHANNEL_POST_FORBIDDEN: "cloud.channels.feed.errorPostForbidden",
  ORG2_CHANNEL_ARCHIVED: "cloud.channels.feed.errorArchived",
  ORG2_CHANNEL_MESSAGES_FULL: "cloud.channels.feed.errorChannelFull",
  ORG2_CHANNEL_NOT_FOUND: "cloud.channels.feed.errorChannelMissing",
  ORG2_NOT_FOUND: "cloud.channels.feed.errorChannelMissing",
  ORG2_MESSAGE_NOT_FOUND: "cloud.channels.feed.errorMessageMissing",
  ORG2_MEMBER_REQUIRED: "cloud.channels.feed.errorPostForbidden",
};

/** The `navigation` key explaining a failed cloud message write. */
export function resolveCloudChannelErrorKey(error: unknown): string {
  const code = org2ChannelMessagesErrorCode(error);
  return (
    (code ? CLOUD_CHANNEL_POST_ERROR_KEYS[code] : undefined) ??
    CHANNEL_POST_ERROR_KEYS.invalid
  );
}

export interface CloudChannelPostHandlerDeps {
  /** Posts the body; rejects with the RPC error (rollback already applied). */
  post: (body: string) => Promise<void>;
  translate: (key: string) => string;
  onError: (message: string | null) => void;
}

/**
 * The cloud twin of `createChannelPostHandler`. Same contract — resolve `true`
 * when handled, THROW so `useSubmitMessage` restores the editor snapshot —
 * with the length bound checked before the round trip (the RPC would answer
 * `ORG2_VALIDATION`, which cannot say WHICH rule was broken) and the server's
 * refusal code mapped to its own copy.
 */
export function createCloudChannelPostHandler(
  deps: CloudChannelPostHandlerDeps
): ChannelPostHandler {
  const { post, translate, onError } = deps;
  return async ({ displayText }: SubmitOverrideInput): Promise<boolean> => {
    const body = displayText.trim();
    if (body.length === 0) return true;
    if (body.length > CHANNEL_MESSAGE_MAX_LENGTH) {
      const message = translate(CHANNEL_POST_ERROR_KEYS.tooLong);
      onError(message);
      throw new Error(message);
    }
    try {
      await post(body);
      onError(null);
      return true;
    } catch (error) {
      const message = translate(resolveCloudChannelErrorKey(error));
      onError(message);
      throw new Error(message);
    }
  };
}
