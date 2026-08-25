import { ChevronRight } from "lucide-react";
import React from "react";

const CARD_BASE = "mt-1.5 flex w-full max-w-[600px] rounded-lg p-3";

export interface ReferenceCardProps {
  testId: string;
  identity?: Record<string, string>;
  ariaLabel: string;
  onOpen: () => void;
  children: React.ReactNode;
}

/** Shared attachment-card chrome for session references in chat surfaces. */
export const ReferenceCard: React.FC<ReferenceCardProps> = ({
  testId,
  identity,
  ariaLabel,
  onOpen,
  children,
}) => (
  <button
    type="button"
    className={`${CARD_BASE} items-center gap-2 border border-border-2 text-left transition-colors hover:bg-fill-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30`}
    data-testid={testId}
    aria-label={ariaLabel}
    onClick={onOpen}
    {...identity}
  >
    <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    <ChevronRight size={14} className="shrink-0 text-text-3" aria-hidden />
  </button>
);

export const ReferenceCardTitle: React.FC<{
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

export const ReferenceCardMeta: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-text-3">
    {children}
  </div>
);

export const ReferenceCardMetaItem: React.FC<{
  icon?: React.ReactNode;
  color?: string;
  children: React.ReactNode;
}> = ({ icon, color, children }) => (
  <span className="inline-flex min-w-0 items-center gap-1" style={{ color }}>
    {icon}
    <span className="truncate">{children}</span>
  </span>
);
