import { openUrl } from "@tauri-apps/plugin-opener";
import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { getGitRemotes } from "@src/api/http/git/remotes";
import { getPRLocal } from "@src/api/tauri/github";
import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import Menu from "@src/components/Menu";
import Message from "@src/components/Message";
import HoverCardBase, {
  HoverCardPanel,
} from "@src/components/SessionHoverCard/HoverCardBase";
import SplitButton from "@src/components/SplitButton";
import {
  Copy01Icon,
  GitPullRequestIcon,
  HugeiconsIcon,
  InternetIcon,
  PanelsTopLeftIcon,
} from "@src/icons";
import { openGitHubPrInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { copyText } from "@src/util/data/clipboard";
import { parseGitHubPullRequestUrl } from "@src/util/git/githubPullRequestUrl";

import {
  type HttpLinkPreview,
  createGitHubPrTabDataFromLink,
  getHttpLinkPreview,
  remoteUrlsMatchGitHubPullRequest,
} from "./LinkHoverCard.helpers";
import { openUrlInBrowserApp } from "./markdownUtils";

interface LinkHoverCardProps {
  url: string;
  children: React.ReactElement;
  workspaceRootPath?: string;
  workspaceRootRepoId?: string;
  workspaceRootRepoUrl?: string;
}

interface LinkHoverCardContentProps {
  preview: HttpLinkPreview;
  workspaceRootPath?: string;
  workspaceRootRepoId?: string;
  workspaceRootRepoUrl?: string;
}

const LinkHoverCardContent: React.FC<LinkHoverCardContentProps> = ({
  preview,
  workspaceRootPath,
  workspaceRootRepoId,
  workspaceRootRepoUrl,
}) => {
  const { t } = useTranslation("sessions");
  const openPrInChatPanel = useSetAtom(openGitHubPrInChatPanelTabAtom);
  const [openOptionsVisible, setOpenOptionsVisible] = useState(false);
  const [openingPr, setOpeningPr] = useState(false);
  const pullRequest = parseGitHubPullRequestUrl(preview.url);

  const handleCopy = useCallback(async () => {
    try {
      await copyText(preview.url);
      Message.success(t("cards.url.copied"));
    } catch {
      Message.error(t("failedToCopyContent"));
    }
  }, [preview.url, t]);

  const handleOpenAsWebPage = useCallback(() => {
    openUrlInBrowserApp(preview.url, { navigate: true });
    setOpenOptionsVisible(false);
  }, [preview.url]);

  const handleOpenAsPullRequest = useCallback(async () => {
    if (!pullRequest || !workspaceRootPath || openingPr) return;

    setOpeningPr(true);
    try {
      const repoFullName = `${pullRequest.owner}/${pullRequest.repo}`;
      const [detail, remotes] = await Promise.all([
        getPRLocal(repoFullName, pullRequest.number),
        getGitRemotes({
          repo_id: workspaceRootRepoId ?? "default",
          repo_path: workspaceRootPath,
        }),
      ]);
      const remoteUrls = [
        workspaceRootRepoUrl,
        ...(remotes?.remotes.flatMap((remote) => [
          remote.url,
          remote.fetch_url,
        ]) ?? []),
      ];
      if (!remoteUrlsMatchGitHubPullRequest(pullRequest, remoteUrls)) {
        throw new Error(
          "The active workspace does not match this pull request"
        );
      }
      const tabData = createGitHubPrTabDataFromLink({
        url: preview.url,
        repoPath: workspaceRootPath,
        repoId: workspaceRootRepoId,
        detail,
      });
      if (!tabData) throw new Error("Invalid GitHub pull request URL");
      openPrInChatPanel(tabData);
      setOpenOptionsVisible(false);
    } catch {
      Message.error(t("cards.url.openPullRequestFailed"));
    } finally {
      setOpeningPr(false);
    }
  }, [
    openPrInChatPanel,
    openingPr,
    preview.url,
    pullRequest,
    t,
    workspaceRootPath,
    workspaceRootRepoId,
    workspaceRootRepoUrl,
  ]);

  const handleOpenExternal = useCallback(() => {
    void openUrl(preview.url).catch(() => {
      Message.error(t("cards.url.openExternalFailed"));
    });
  }, [preview.url, t]);

  return (
    <HoverCardPanel title={preview.host} allowOverflow>
      <div
        className="truncate text-[12px] leading-5 text-text-3"
        title={preview.url}
      >
        {preview.displayUrl}
      </div>
      <div className="flex items-center justify-end gap-1 border-t border-border-1 pt-2">
        <Button
          variant="tertiary"
          size="mini"
          icon={<HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={13} />}
          iconOnly
          aria-label={t("cards.url.copyUrl")}
          title={t("cards.url.copyUrl")}
          onClick={handleCopy}
        />
        <Button
          variant="tertiary"
          size="mini"
          icon={
            <HugeiconsIcon
              icon={InternetIcon}
              data-icon="chrome"
              size={13}
              strokeWidth={1.75}
            />
          }
          iconOnly
          aria-label={t("cards.actions.openWithDefaultBrowser")}
          title={t("cards.actions.openWithDefaultBrowser")}
          onClick={handleOpenExternal}
        />
        {pullRequest && workspaceRootPath ? (
          <SplitButton
            variant="primary"
            size="mini"
            loading={openingPr}
            icon={
              <HugeiconsIcon
                icon={GitPullRequestIcon}
                data-icon="git-pull-request"
                size={13}
                strokeWidth={1.75}
                aria-hidden
              />
            }
            onClick={() => void handleOpenAsPullRequest()}
            menuOpen={openOptionsVisible}
            menuButtonLabel={t("cards.actions.moreOpenOptions")}
            onMenuButtonClick={(event) => {
              event.stopPropagation();
              setOpenOptionsVisible((visible) => !visible);
            }}
            menu={
              <Dropdown
                trigger="click"
                position="bottom-end"
                popupVisible={openOptionsVisible}
                onVisibleChange={setOpenOptionsVisible}
                droplist={
                  <Menu>
                    <Menu.Item
                      key="pull-request"
                      onClick={() => void handleOpenAsPullRequest()}
                    >
                      <HugeiconsIcon
                        icon={GitPullRequestIcon}
                        data-icon="git-pull-request"
                        size={14}
                        aria-hidden
                      />
                      {t("cards.actions.openAsPullRequest")}
                    </Menu.Item>
                    <Menu.Item key="web-page" onClick={handleOpenAsWebPage}>
                      <HugeiconsIcon
                        icon={PanelsTopLeftIcon}
                        data-icon="panels-top-left"
                        size={14}
                        aria-hidden
                      />
                      {t("cards.actions.openAsWebPage")}
                    </Menu.Item>
                  </Menu>
                }
              >
                <div />
              </Dropdown>
            }
            widthMode="hug"
          >
            {t("input.pr.open")}
          </SplitButton>
        ) : (
          <Button variant="primary" size="mini" onClick={handleOpenAsWebPage}>
            {t("cards.actions.openAsWebPage")}
          </Button>
        )}
      </div>
    </HoverCardPanel>
  );
};

const LinkHoverCard: React.FC<LinkHoverCardProps> = ({
  url,
  children,
  workspaceRootPath,
  workspaceRootRepoId,
  workspaceRootRepoUrl,
}) => {
  const preview = getHttpLinkPreview(url);
  if (!preview) return children;

  return (
    <HoverCardBase
      cardId={preview.url}
      position="bottom-start"
      mouseEnterDelay={350}
      renderContent={() => (
        <LinkHoverCardContent
          preview={preview}
          workspaceRootPath={workspaceRootPath}
          workspaceRootRepoId={workspaceRootRepoId}
          workspaceRootRepoUrl={workspaceRootRepoUrl}
        />
      )}
    >
      {children}
    </HoverCardBase>
  );
};

LinkHoverCard.displayName = "LinkHoverCard";

export default LinkHoverCard;
