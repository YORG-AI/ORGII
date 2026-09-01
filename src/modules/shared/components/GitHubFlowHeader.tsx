/**
 * GitHubFlowHeader
 *
 * Shared GitHub-style flow title used by pull-request and issue detail bodies:
 * the large entity title with its muted #number, then a status pill followed by
 * the flow sentence ("{actor} {what they did} …"). Callers supply the status
 * pill and the tail of the sentence so both surfaces keep one exact format.
 */
import React from "react";

import PersonAvatar from "@src/components/PersonAvatar";

export interface GitHubFlowHeaderActor {
  login: string;
  avatarUrl: string;
}

interface GitHubFlowHeaderProps {
  title: string;
  number: number;
  /** Status pill rendered ahead of the flow sentence. */
  status: React.ReactNode;
  actor: GitHubFlowHeaderActor | null;
  /** Shown in place of the actor name when the payload carries no author. */
  unknownActorLabel: string;
  /** Tail of the flow sentence, rendered after the actor name. */
  children?: React.ReactNode;
  ariaLabel?: string;
  /** Prefix for this surface's test ids (e.g. `pr-flow` → `pr-flow-header`). */
  testIdPrefix: string;
}

export function GitHubFlowHeader({
  title,
  number,
  status,
  actor,
  unknownActorLabel,
  children,
  ariaLabel,
  testIdPrefix,
}: GitHubFlowHeaderProps): React.ReactNode {
  return (
    <section
      data-testid={`${testIdPrefix}-header`}
      aria-label={ariaLabel}
      className="flex min-w-0 flex-col gap-2"
    >
      <h2
        data-testid={`${testIdPrefix}-title`}
        className="min-w-0 text-[20px] leading-7 font-semibold text-text-1 select-text"
      >
        {title}{" "}
        <span className="font-normal whitespace-nowrap text-text-3">
          #{number}
        </span>
      </h2>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          data-testid={`${testIdPrefix}-status`}
          className="inline-flex shrink-0"
        >
          {status}
        </span>
        <span
          data-testid={`${testIdPrefix}-subline`}
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-text-2"
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

export default GitHubFlowHeader;
