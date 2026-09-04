import type { ReactNode } from "react";

import AnyIcon from "@src/components/AnyIcon";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type IconSvgElement,
  WorkflowCircle05Icon,
} from "@src/icons";
import type { BranchPrSnapshot } from "@src/store/git";
import {
  type SessionGitLinkSource,
  resolveSessionGitLink,
} from "@src/util/session/sessionGitLink";

/**
 * Icon + color per PR state. Semantics match `shared/pr/prStatus` — open is
 * success, merged is GitHub purple, closed is danger, draft is neutral — so
 * a row marker and a PR badge elsewhere in the app never disagree about a
 * state.
 */
const PR_STATUS_PRESENTATION: Record<
  string,
  { Icon: IconSvgElement; color: string; label: string }
> = {
  open: {
    Icon: GitPullRequestIcon,
    color: "var(--color-success-6)",
    label: "Open PR",
  },
  draft: {
    Icon: GitPullRequestDraftIcon,
    color: "var(--color-text-3)",
    label: "Draft PR",
  },
  merged: {
    Icon: GitMergeIcon,
    color: "var(--color-purple-6)",
    label: "Merged PR",
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    color: "var(--color-danger-6)",
    label: "Closed PR",
  },
};

/**
 * Git marker rendered immediately BEFORE the row's status dot.
 *
 * Every glyph it can draw answers exactly one question — "what is the state of
 * this session's pull request?" — with one deliberate addition: a worktree
 * whose work is still in flight, which no PR can describe yet.
 *
 * There is NO generic branch fallback. A muted branch glyph would have to
 * stand for "no PR exists", "the repo's PRs have not loaded yet", "this remote
 * is not GitHub", and "the PR is in a state we do not recognize" all at once,
 * which makes it unreadable. Those rows render their status dot alone.
 *
 * Glyph only: the branch name and PR title live in the session hover card, so
 * this never widens the row.
 */
export function renderSessionGitIndicator(
  session: SessionGitLinkSource,
  pr?: BranchPrSnapshot
): ReactNode {
  const link = resolveSessionGitLink(session);
  if (!link) return null;

  const prPresentation = pr ? PR_STATUS_PRESENTATION[pr.status] : undefined;
  if (!prPresentation && !link.isActiveWorktree) return null;

  const { Icon, color, label } = prPresentation ?? {
    Icon: WorkflowCircle05Icon,
    color: "var(--color-success-6)",
    label: "Worktree branch",
  };

  return (
    <span
      aria-label={
        prPresentation
          ? `${label} #${pr?.number}: ${link.branch}`
          : `${label}: ${link.branch}`
      }
      className="inline-flex shrink-0 items-center leading-none"
      style={{ color }}
    >
      <AnyIcon icon={Icon} size={11} strokeWidth={2} />
    </span>
  );
}
