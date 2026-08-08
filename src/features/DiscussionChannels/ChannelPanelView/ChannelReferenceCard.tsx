/**
 * The chrome every channel reference card wears.
 *
 * Sessions, work items and GitHub issues/PRs each answer a different question
 * ("what is this session doing", "what state is this item in", "which issue is
 * this") and so each owns its own body — but they are all the same OBJECT in
 * the transcript: an attachment hanging under a message, opened by one click.
 * That part lives here once, so a change to the card's weight, hover, or
 * degraded treatment lands on all three instead of two of them.
 *
 * Two variants:
 *
 *  - **resolved** — a `button`, because it opens something. Border-only (no
 *    fill) so a run of cards does not read as a stack of blocks, with a
 *    trailing chevron for the affordance.
 *  - **degraded** — a `div`, dashed, muted, no chevron. Used only when the
 *    target has no valid navigation path (for example, an unreadable work
 *    item), so the UI never presents a dead button.
 */
import { ChevronRight } from "lucide-react";
import React from "react";

/** Cards sit inside the 900px transcript column but read as attachments, not
 *  full-width blocks, so they stop well short of the message text. */
const CARD_MAX_WIDTH = "max-w-[600px]";

const CARD_BASE = `mt-1.5 flex w-full rounded-lg p-3 ${CARD_MAX_WIDTH}`;

export interface ChannelReferenceCardProps {
  testId: string;
  /**
   * Identity attributes for the root (`data-session-id`, …). Kept as data
   * attributes rather than props on the shell so each card names its target
   * in its own vocabulary.
   */
  identity?: Record<string, string>;
  ariaLabel: string;
  onOpen: () => void;
  children: React.ReactNode;
}

/** The clickable card: icon + title row and a meta strip go in `children`. */
export const ChannelReferenceCard: React.FC<ChannelReferenceCardProps> = ({
  testId,
  identity,
  ariaLabel,
  onOpen,
  children,
}) => (
  <button
    type="button"
    className={`${CARD_BASE} items-center gap-2 border border-border-2 text-left transition-colors hover:bg-fill-1`}
    data-testid={testId}
    aria-label={ariaLabel}
    onClick={onOpen}
    {...identity}
  >
    <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    <ChevronRight size={14} className="shrink-0 text-text-3" aria-hidden />
  </button>
);

export interface ChannelReferenceCardMissingProps {
  testId: string;
  identity?: Record<string, string>;
  /** The snapshot taken when the reference was posted. */
  title: string;
  /** Why there is nothing to open. */
  note: string;
}

/** The card for a reference whose target could not be resolved. */
export const ChannelReferenceCardMissing: React.FC<
  ChannelReferenceCardMissingProps
> = ({ testId, identity, title, note }) => (
  <div
    className={`${CARD_BASE} flex-col gap-0.5 border border-dashed border-border-2`}
    data-testid={testId}
    {...identity}
  >
    <span className="truncate text-[13px] font-medium text-text-3">
      {title}
    </span>
    <span className="text-[11px] text-text-4">{note}</span>
  </div>
);

/** Title row: leading icon, title, optional trailing badge. */
export const ChannelReferenceCardTitle: React.FC<{
  icon: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
}> = ({ icon, title, trailing }) => (
  <div className="flex min-w-0 items-center gap-1.5">
    <span className="inline-flex shrink-0 items-center text-text-1">
      {icon}
    </span>
    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1">
      {title}
    </span>
    {trailing ? (
      <span className="inline-flex shrink-0 items-center">{trailing}</span>
    ) : null}
  </div>
);

/** Footer strip of small facts under the title. */
export const ChannelReferenceCardMeta: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-text-3">
    {children}
  </div>
);

/** One fact in the meta strip. */
export const ChannelReferenceCardMetaItem: React.FC<{
  icon?: React.ReactNode;
  /** Overrides the strip's muted tone (status / priority accents). */
  color?: string;
  children: React.ReactNode;
}> = ({ icon, color, children }) => (
  <span className="inline-flex min-w-0 items-center gap-1" style={{ color }}>
    {icon}
    <span className="truncate">{children}</span>
  </span>
);
