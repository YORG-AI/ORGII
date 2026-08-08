/**
 * A GitHub issue or pull request referenced by a posted channel message.
 *
 * **Links only — this card never calls the GitHub API.** Everything it shows
 * comes out of the URL itself via `parseGitHubPillUrl`: `owner/repo#123` and
 * whether the target is an issue or a PR. That is a deliberate ceiling. Live
 * state (open/merged/draft, title, author) would need a token this surface has
 * no claim on, a rate budget shared with the sync adapters, and a refresh
 * story for a transcript that may hold hundreds of references. A card that
 * silently showed a stale "open" badge would be worse than one that shows the
 * reference and gets out of the way.
 *
 * Because there is nothing to fetch there is also nothing to degrade: a URL
 * that `parseGitHubPillUrl` cannot read never becomes a card in the first
 * place (`channelMessageBody` leaves it in the prose), so this component only
 * ever renders the resolved variant.
 *
 * The kind glyph is lucide's `GitPullRequest` / `CircleDot` rather than the
 * shared GitHub brand mark: the brand mark says "GitHub", which the
 * `owner/repo#n` label already says, while these two say issue-vs-PR — the
 * one thing the URL knows that the label does not spell out.
 *
 * Clicking leaves the app, so it goes through `openExternalLink` (Tauri's
 * shell opener) like every other outbound link here, never `window.open`.
 */
import { CircleDot, GitPullRequest } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  ChannelReferenceCard,
  ChannelReferenceCardMeta,
  ChannelReferenceCardMetaItem,
  ChannelReferenceCardTitle,
} from "./ChannelReferenceCard";

const log = createLogger("ChannelGitHubCard");

const CARD_TEST_ID = "channel-github-card";

export interface ChannelGitHubCardProps {
  /** Canonical issue/PR URL from `parseGitHubPillUrl`. */
  url: string;
  /** `owner/repo#123`. */
  displayName: string;
  resource: "issue" | "pr";
}

const ChannelGitHubCard: React.FC<ChannelGitHubCardProps> = ({
  url,
  displayName,
  resource,
}) => {
  const { t } = useTranslation("navigation");

  const handleOpen = useCallback(() => {
    void openExternalLink(url).catch((error: unknown) => {
      log.warn("failed to open GitHub reference", url, error);
    });
  }, [url]);

  const kindLabel = t(
    resource === "pr"
      ? "cloud.channels.feed.githubPullRequest"
      : "cloud.channels.feed.githubIssue"
  );

  return (
    <ChannelReferenceCard
      testId={CARD_TEST_ID}
      identity={{ "data-github-url": url, "data-github-resource": resource }}
      ariaLabel={t("cloud.channels.feed.githubCardOpen", {
        name: displayName,
      })}
      onOpen={handleOpen}
    >
      <ChannelReferenceCardTitle
        icon={
          resource === "pr" ? (
            <GitPullRequest size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <CircleDot size={12} strokeWidth={1.75} aria-hidden />
          )
        }
        title={displayName}
      />
      <ChannelReferenceCardMeta>
        <ChannelReferenceCardMetaItem>{kindLabel}</ChannelReferenceCardMetaItem>
      </ChannelReferenceCardMeta>
    </ChannelReferenceCard>
  );
};

export default ChannelGitHubCard;
