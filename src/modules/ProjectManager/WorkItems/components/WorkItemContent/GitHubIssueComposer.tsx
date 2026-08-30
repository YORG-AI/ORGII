import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ComposerShell from "@src/components/ComposerShell";
import ComposerSurface from "@src/components/ComposerSurface";
import PersonAvatar from "@src/components/PersonAvatar";
import MarkdownTextareaEditor, {
  type MarkdownEditorMode,
} from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import { LoadingBar } from "@src/modules/shared/layouts/blocks";

import GitHubIssueCloseButton from "./GitHubIssueCloseButton";
import type {
  GitHubIssueInteractionConfig,
  GitHubIssueStatusChangeOptions,
} from "./types";

interface GitHubIssueComposerProps {
  interaction: GitHubIssueInteractionConfig;
}

const GitHubIssueComposer: React.FC<GitHubIssueComposerProps> = ({
  interaction,
}) => {
  const { t } = useTranslation("common");
  const [commentBody, setCommentBody] = useState("");
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>("write");
  const hasComment = commentBody.trim().length > 0;

  if (interaction.loading) {
    return (
      <section data-testid="github-issue-inline-composer-loading">
        <ComposerShell variant="default" className="!gap-0 !p-0">
          <LoadingBar />
        </ComposerShell>
      </section>
    );
  }

  const handleComment = async () => {
    const body = commentBody.trim();
    if (!body || !interaction.canComment || interaction.submittingComment) {
      return;
    }
    try {
      await interaction.onAddComment(body);
      setCommentBody("");
      setEditorMode("write");
    } catch {
      // The interaction owns the localized error state; keep the draft intact.
    }
  };

  const handleStatusChange = async (
    nextStatus: GitHubIssueInteractionConfig["issueState"],
    options?: GitHubIssueStatusChangeOptions
  ) => {
    if (
      interaction.updatingStatus ||
      interaction.updatingBody ||
      interaction.submittingComment
    ) {
      return;
    }
    try {
      if (hasComment && interaction.canComment) {
        await interaction.onAddComment(commentBody.trim());
        setCommentBody("");
      }
      await interaction.onStatusChange(nextStatus, options);
    } catch {
      // Keep an unsubmitted draft in place; the interaction renders the error.
    }
  };

  return (
    <section
      data-testid="github-issue-inline-composer"
      aria-label={t("git.issues.composer.addComment")}
      className="flex flex-col gap-1.5"
    >
      {interaction.canManageStatus ? (
        <div
          className="flex min-h-9 flex-wrap items-center gap-2 px-1"
          data-testid="github-issue-level-actions"
        >
          <GitHubIssueCloseButton
            interaction={interaction}
            onStatusChange={handleStatusChange}
          />
        </div>
      ) : null}

      <ComposerSurface
        variant="default"
        className="overflow-visible !pt-1.5"
        data-testid="github-issue-comment-input"
        leadingActions={
          <div className="flex min-w-0 items-center gap-2">
            <MarkdownEditorModeSwitch
              mode={editorMode}
              onModeChange={setEditorMode}
              disabled={
                !interaction.canComment || interaction.submittingComment
              }
              dataTestId="github-issue-comment-mode-switch"
            />
            {interaction.viewer ? (
              <div
                className="flex min-w-0 items-center gap-2"
                data-testid="github-issue-comment-viewer"
                aria-label={t("git.issues.composer.commentingAs", {
                  login: interaction.viewer.login,
                })}
              >
                <PersonAvatar
                  size={22}
                  name={interaction.viewer.login}
                  src={interaction.viewer.avatar_url}
                />
                <span className="truncate text-xs text-text-2">
                  {interaction.viewer.login}
                </span>
              </div>
            ) : (
              <span className="text-xs text-text-3">
                {t("git.issues.composer.identityUnavailable")}
              </span>
            )}
          </div>
        }
        trailingActions={
          <Button
            htmlType="button"
            variant="primary"
            size="small"
            shape="round"
            loading={interaction.submittingComment}
            disabled={!hasComment || !interaction.canComment}
            onClick={() => void handleComment()}
            data-testid="github-issue-comment-submit"
          >
            {t("git.issues.composer.submitComment")}
          </Button>
        }
      >
        <MarkdownTextareaEditor
          value={commentBody}
          onChange={(markdown) => setCommentBody(markdown)}
          onSubmit={() => void handleComment()}
          placeholder={t("git.issues.composer.commentPlaceholder")}
          minHeight={100}
          maxHeight={500}
          appearance="plain"
          editable={interaction.canComment && !interaction.submittingComment}
          mode={editorMode}
          onModeChange={setEditorMode}
          dataTestId="github-issue-comment-editor"
        />

        {interaction.error ? (
          <p className="px-3 pb-2 text-xs text-danger-6" role="status">
            {interaction.error === "comment"
              ? t("git.issues.composer.commentFailed")
              : t("git.issues.composer.statusFailed")}
          </p>
        ) : null}
      </ComposerSurface>
    </section>
  );
};

export default GitHubIssueComposer;
