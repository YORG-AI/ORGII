import React from "react";

import PersonAvatar from "@src/components/PersonAvatar";

export const DETAIL_FLOW_HEADER_TOKENS = {
  container: "flex min-w-0 flex-col gap-2",
  title: "min-w-0 text-[20px] leading-7 font-semibold text-text-1 select-text",
  metadataRow: "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5",
  subline:
    "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-text-2",
} as const;

export interface DetailFlowHeaderActor {
  login: string;
  avatarUrl: string;
}

interface DetailFlowHeaderProps {
  title: string;
  identifier?: React.ReactNode;
  /** Status pill rendered ahead of the flow sentence. */
  status: React.ReactNode;
  actor: DetailFlowHeaderActor | null;
  /** Shown in place of the actor name when the payload carries no author. */
  unknownActorLabel: string;
  /** Tail of the flow sentence, rendered after the actor name. */
  children?: React.ReactNode;
  ariaLabel?: string;
  /** Prefix for this surface's test ids (e.g. `pr-flow`). */
  testIdPrefix: string;
}

/** Full, wrapping entity title plus the shared PR-style activity subline. */
export default function DetailFlowHeader({
  title,
  identifier,
  status,
  actor,
  unknownActorLabel,
  children,
  ariaLabel,
  testIdPrefix,
}: DetailFlowHeaderProps): React.ReactNode {
  return (
    <section
      data-testid={`${testIdPrefix}-header`}
      aria-label={ariaLabel}
      className={DETAIL_FLOW_HEADER_TOKENS.container}
    >
      <h2
        data-testid={`${testIdPrefix}-title`}
        className={DETAIL_FLOW_HEADER_TOKENS.title}
      >
        {title}
        {identifier ? (
          <>
            {" "}
            <span className="font-normal whitespace-nowrap text-text-3">
              {identifier}
            </span>
          </>
        ) : null}
      </h2>
      <div className={DETAIL_FLOW_HEADER_TOKENS.metadataRow}>
        <span
          data-testid={`${testIdPrefix}-status`}
          className="inline-flex shrink-0"
        >
          {status}
        </span>
        <span
          data-testid={`${testIdPrefix}-subline`}
          className={DETAIL_FLOW_HEADER_TOKENS.subline}
        >
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            title={actor?.login}
          >
            {actor ? (
              <PersonAvatar
                size={16}
                name={actor.login}
                src={actor.avatarUrl}
              />
            ) : null}
            <span className="max-w-[160px] truncate font-medium text-text-1">
              {actor?.login ?? unknownActorLabel}
            </span>
          </span>
          {children}
        </span>
      </div>
    </section>
  );
}
