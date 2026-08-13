import { useCallback, useMemo, useRef, useState } from "react";

import ComposerSurface from "@src/components/ComposerSurface";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { CloudSessionReferencePreview } from "@src/features/Org2Cloud/CloudSessionReferencePreview";
import { useSessionReferenceDropTarget } from "@src/features/Org2Cloud/useSessionReferenceDropTarget";
import RichMarkdownEditor, {
  RICH_MARKDOWN_COMPOSER_TOOLBAR_CLASS,
  type RichMarkdownEditorRef,
} from "@src/modules/shared/components/RichMarkdownEditor";
import Modal from "@src/scaffold/ModalSystem";

import type { GitHubRepoSource } from "./githubWorkItemsTypes";

interface CreateIssueModalProps {
  open: boolean;
  repoSources: GitHubRepoSource[];
  selectedRepo: GitHubRepoSource | null;
  creating: boolean;
  labels: {
    title: string;
    issueTitlePlaceholder: string;
    issueBodyPlaceholder: string;
    repository: string;
    cancel: string;
    create: string;
    creating: string;
  };
  onCreateIssue: (
    source: GitHubRepoSource,
    title: string,
    body: string
  ) => void;
  onCancel: () => void;
}

export function CreateIssueModal({
  open,
  repoSources,
  selectedRepo,
  creating,
  labels,
  onCreateIssue,
  onCancel,
}: CreateIssueModalProps) {
  const [repoKey, setRepoKey] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const bodyEditorRef = useRef<RichMarkdownEditorRef>(null);
  const bodyDropTargetRef = useRef<HTMLDivElement>(null);
  const insertDroppedReference = useCallback(
    (text: string, dropPoint?: { clientX: number; clientY: number }) => {
      bodyEditorRef.current?.insertText(text, {
        separateFromAdjacentText: true,
        clientX: dropPoint?.clientX,
        clientY: dropPoint?.clientY,
      });
    },
    []
  );
  const { isDragOver: bodyDragOver } = useSessionReferenceDropTarget({
    elementRef: bodyDropTargetRef,
    onInsertText: insertDroppedReference,
    enabled: open,
  });
  const effectiveRepoKey =
    repoKey || selectedRepo?.repoFullName || repoSources[0]?.repoFullName || "";
  const source =
    repoSources.find((item) => item.repoFullName === effectiveRepoKey) ??
    selectedRepo ??
    repoSources[0] ??
    null;
  const repoOptions = useMemo<SelectOption[]>(
    () =>
      repoSources.map((item) => ({
        label: item.repoFullName,
        value: item.repoFullName,
      })),
    [repoSources]
  );
  const reset = () => {
    setRepoKey("");
    setTitle("");
    setBody("");
  };
  const handleCancel = () => {
    reset();
    onCancel();
  };
  const handleCreate = () => {
    const trimmedTitle = title.trim();
    if (!source || !trimmedTitle) return;
    onCreateIssue(source, trimmedTitle, body.trim());
    reset();
  };

  return (
    <Modal
      visible={open}
      title={labels.title}
      onCancel={handleCancel}
      onOk={handleCreate}
      okText={creating ? labels.creating : labels.create}
      cancelText={labels.cancel}
      okButtonProps={{ loading: creating, disabled: !source || !title.trim() }}
      width={640}
      bodyClassName="p-4"
    >
      <div className="flex flex-col gap-3">
        <Select
          value={effectiveRepoKey}
          options={repoOptions}
          onChange={(value) => setRepoKey(String(value))}
          showSearch
          size="small"
          panelZIndex={10001}
          dropdownWidthMode="match"
          ariaLabel={labels.repository}
        />
        <Input
          value={title}
          onChange={setTitle}
          placeholder={labels.issueTitlePlaceholder}
          size="default"
        />
        <ComposerSurface
          ref={bodyDropTargetRef}
          variant="default"
          className={`overflow-visible !pt-1.5 ${
            bodyDragOver ? "!ring-2 !ring-primary-6" : ""
          }`.trim()}
          data-testid="create-github-issue-description"
        >
          <RichMarkdownEditor
            ref={bodyEditorRef}
            value={body}
            onChange={setBody}
            placeholder={labels.issueBodyPlaceholder}
            minHeight={180}
            maxHeight={420}
            appearance="plain"
            toolbarMode="inline"
            toolbarSize="mini"
            toolbarClassName={RICH_MARKDOWN_COMPOSER_TOOLBAR_CLASS}
            toolbarDropdownPosition="top-start"
            editable={!creating}
            dataTestId="create-github-issue-description-editor"
          />
          <CloudSessionReferencePreview text={body} className="px-1.5" />
        </ComposerSurface>
      </div>
    </Modal>
  );
}
