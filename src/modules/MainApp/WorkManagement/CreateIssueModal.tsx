import { useMemo, useRef, useState } from "react";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { useSessionReferenceDropTarget } from "@src/features/Org2Cloud/useSessionReferenceDropTarget";
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
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const { isDragOver: bodyDragOver } = useSessionReferenceDropTarget({
    elementRef: bodyRef,
    value: body,
    onChange: setBody,
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
      width={520}
      bodyClassName="p-4"
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-text-2">
          {labels.repository}
          <Select
            value={effectiveRepoKey}
            options={repoOptions}
            onChange={(value) => setRepoKey(String(value))}
            showSearch
            size="small"
            panelZIndex={10001}
            dropdownWidthMode="match"
          />
        </label>
        <Input
          value={title}
          onChange={setTitle}
          placeholder={labels.issueTitlePlaceholder}
          size="default"
        />
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className={`bg-surface-0 focus:border-accent-5 min-h-28 w-full resize-none rounded-lg border px-3 py-2 text-[13px] text-text-1 outline-none placeholder:text-text-4 ${
            bodyDragOver ? "border-primary-6" : "border-border-2"
          }`}
          placeholder={labels.issueBodyPlaceholder}
        />
      </div>
    </Modal>
  );
}
