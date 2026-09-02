/**
 * Channel composer footer — the session composer, not a look-alike.
 *
 * An earlier pass concluded `InputArea` was session-bound and hand-rolled a
 * `Textarea` instead. That call was wrong: `HumanSessionView` already drives
 * `InputArea` outside any agent session with `sessionScope="none"`, and this
 * footer copies that call shape verbatim — same props, same absolutely
 * positioned shell, same `pointer-events-none` fade over the transcript, same
 * `CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth` column the message rows use, so the
 * composer lines up with the transcript above it.
 *
 * Cloud channels render the SAME composer in a disabled state rather than a
 * bespoke notice card: `0014_org_channels.sql` ships the control plane only, so
 * there is nothing to post to yet, and the surface says so above the input
 * instead of pretending to send.
 */
import React from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import InputArea from "@src/engines/ChatPanel/InputArea";

import type { ChannelPostHandler } from "./channelPostHandler";

// Channels opt out of agent interceptors, so agent-only built-ins (canvas,
// compact) must not appear in the "/" menu either — same skill-only filter
// the Work Log composer uses (see HumanSessionView).
const CHANNEL_SLASH_ITEM_CATEGORIES = ["skill"] as const;

export interface ChannelComposerProps {
  /**
   * Namespaces the composer per channel — passed to `InputArea` as both its
   * remount key and its `sessionId`, so switching channels never inherits the
   * previous one's editor state.
   */
  composerId: string;
  placeholder: string;
  /** Null on the cloud variant: there is no message plane to post to. */
  onSubmit: ChannelPostHandler | null;
  /** Explanation rendered above the composer (cloud gate copy). */
  notice?: React.ReactNode;
  /** Inline refusal from the last post (already localized). */
  error?: string | null;
  /** The footer element, so the panel can hit-test drops against it. */
  footerRef?: React.RefObject<HTMLElement | null>;
  /**
   * Receives the live editor handle so a session dropped anywhere on the
   * channel surface — not just on the input rect — becomes a pill here.
   */
  composerInputRef?: React.MutableRefObject<ComposerInputRef | null>;
  /** False on the cloud variant: a dropped reference could never be posted. */
  acceptDraggedPills?: boolean;
}

const noopSubmit: ChannelPostHandler = async () => true;

const ChannelComposer: React.FC<ChannelComposerProps> = ({
  composerId,
  placeholder,
  onSubmit,
  notice,
  error,
  footerRef,
  composerInputRef,
  acceptDraggedPills = true,
}) => (
  <footer
    ref={footerRef as React.Ref<HTMLElement>}
    className={`absolute right-0 bottom-0 left-0 z-50 flex w-full flex-col items-center px-2 pt-1 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
    data-testid="channel-composer"
  >
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-[-28px] bottom-0 bg-linear-to-t from-chat-pane via-chat-pane/90 to-transparent"
    />
    <div
      className={`relative z-10 flex w-full flex-col gap-1.5 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
    >
      {notice}
      {error ? (
        <div
          role="alert"
          className="px-2 text-xs text-danger-6"
          data-testid="channel-composer-error"
        >
          {error}
        </div>
      ) : null}
      <InputArea
        key={composerId}
        omitChatHeader
        bottomAnchored
        composerInputRef={composerInputRef}
        acceptDraggedPills={acceptDraggedPills}
        sessionId={composerId}
        sessionScope="none"
        placeholder={placeholder}
        onSubmitOverride={onSubmit ?? noopSubmit}
        submitDisabled={onSubmit === null}
        disableStopWhenEmpty
        showAgentControls={false}
        allowFileAttachments={false}
        enableAgentInterceptors={false}
        slashItemCategories={CHANNEL_SLASH_ITEM_CATEGORIES}
      />
    </div>
  </footer>
);

export default ChannelComposer;
