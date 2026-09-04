import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssueLabel, GitHubIssueUser } from "@src/api/tauri/github";
import AvatarChip from "@src/components/AvatarChip";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Tag from "@src/components/Tag";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import { getLabelColorStyle } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
import MarkdownTextareaEditor, {
  type MarkdownEditorMode,
} from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";

interface NewIssueFormProps {
  onSubmit: (
    title: string,
    body: string,
    labels: string[],
    assignees: string[]
  ) => Promise<void>;
  onCancel: () => void;
  repoLabels: GitHubIssueLabel[];
  collaborators: GitHubIssueUser[];
  loading: boolean;
}

export const NewIssueForm: React.FC<NewIssueFormProps> = memo(
  ({ onSubmit, onCancel, repoLabels, collaborators, loading }) => {
    const { t } = useTranslation("common");

    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [editorMode, setEditorMode] = useState<MarkdownEditorMode>("write");
    const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
    const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);

    const titleRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      titleRef.current?.focus();
    }, []);

    const handleLabelToggle = useCallback((name: string) => {
      setSelectedLabels((prev) =>
        prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name]
      );
    }, []);

    const handleAssigneeToggle = useCallback((login: string) => {
      setSelectedAssignees((prev) =>
        prev.includes(login)
          ? prev.filter((a) => a !== login)
          : [...prev, login]
      );
    }, []);

    const handleSubmit = useCallback(
      async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || loading) return;
        await onSubmit(
          title.trim(),
          body.trim(),
          selectedLabels,
          selectedAssignees
        );
      },
      [title, body, selectedLabels, selectedAssignees, loading, onSubmit]
    );

    return (
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-col gap-2 border-b border-border-1 px-3 py-3"
      >
        {/* Title */}
        <Input
          ref={titleRef}
          value={title}
          onChange={(val) => setTitle(val)}
          placeholder={t("git.issues.newIssueTitlePlaceholder", "Issue title")}
          size="small"
          required
        />

        {/* Body */}
        <MarkdownTextareaEditor
          value={body}
          onChange={(markdown) => setBody(markdown)}
          placeholder={t(
            "git.issues.newIssueBodyPlaceholder",
            "Describe the issue (optional)…"
          )}
          minHeight={96}
          maxHeight={240}
          appearance="outlined"
          mode={editorMode}
          onModeChange={setEditorMode}
          dataTestId="new-issue-body-editor"
        />

        {/* Labels */}
        {repoLabels.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={`${TYPOGRAPHY.badge} text-text-3 uppercase`}>
              Labels
            </span>
            <div className="flex flex-wrap gap-1">
              {repoLabels.map((label) => {
                const isSelected = selectedLabels.includes(label.name);
                const style = isSelected
                  ? {
                      ...getLabelColorStyle(label.color),
                      borderColor: "transparent",
                    }
                  : { backgroundColor: "transparent" };
                return (
                  <Tag
                    key={label.id}
                    size="mini"
                    pill
                    checkable
                    checked={isSelected}
                    onCheck={() => handleLabelToggle(label.name)}
                    className={`${TYPOGRAPHY.badge} px-1.5! py-px! leading-tight! transition-opacity ${
                      isSelected
                        ? "opacity-100"
                        : "border border-border-2 text-text-2 opacity-60 hover:opacity-100"
                    }`}
                    style={style}
                  >
                    {label.name}
                  </Tag>
                );
              })}
            </div>
          </div>
        )}

        {/* Assignees */}
        {collaborators.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={`${TYPOGRAPHY.badge} text-text-3 uppercase`}>
              Assignees
            </span>
            <div className="flex flex-wrap gap-1">
              {collaborators.slice(0, 20).map((user) => {
                const isSelected = selectedAssignees.includes(user.login);
                return (
                  <AvatarChip
                    key={user.login}
                    variant="selectable"
                    selected={isSelected}
                    avatarSize={14}
                    avatarName={user.login}
                    avatarSrc={user.avatar_url}
                    label={user.login}
                    className={TYPOGRAPHY.secondary}
                    onClick={() => handleAssigneeToggle(user.login)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-2">
          <MarkdownEditorModeSwitch
            mode={editorMode}
            onModeChange={setEditorMode}
            disabled={loading}
            dataTestId="new-issue-body-mode-switch"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={11} />
              }
              disabled={loading}
              onClick={onCancel}
            >
              {t("actions.cancel", "Cancel")}
            </Button>
            <Button
              htmlType="submit"
              variant="primary"
              size="mini"
              loading={loading}
              disabled={!title.trim() || loading}
            >
              {t("actions.create", "Create")}
            </Button>
          </div>
        </div>
      </form>
    );
  }
);

NewIssueForm.displayName = "NewIssueForm";
