/**
 * GitHubFlowHeader
 *
 * Shared GitHub-style flow title used by pull-request and issue detail bodies:
 * the large entity title with its muted #number, then a status pill followed by
 * the flow sentence ("{actor} {what they did} …"). Callers supply the status
 * pill and the tail of the sentence so both surfaces keep one exact format.
 */
import React from "react";

import DetailFlowHeader from "@src/modules/shared/components/DetailFlowHeader";

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
    <DetailFlowHeader
      title={title}
      identifier={`#${number}`}
      status={status}
      actor={actor}
      unknownActorLabel={unknownActorLabel}
      ariaLabel={ariaLabel}
      testIdPrefix={testIdPrefix}
    >
      {children}
    </DetailFlowHeader>
  );
}

export default GitHubFlowHeader;
