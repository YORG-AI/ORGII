import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PROJECT_GIT_FOLDER_CONFLICT_KIND,
  PROJECT_GIT_FOLDER_SYNC_STATUS,
  type ProjectGitFolderSyncConflict,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import { Message } from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { CodeMirrorConflictEditor } from "@src/features/CodeMirror";
import {
  projectGitFolderSyncResultByOrgAtom,
  setProjectGitFolderSyncResultAtom,
} from "@src/store/project";

interface ProjectGitSyncReviewContentProps {
  orgId: string;
  orgName?: string;
}

function conflictLabel(conflict: ProjectGitFolderSyncConflict): string {
  return (
    conflict.work_item_short_id ??
    conflict.project_slug ??
    conflict.relative_path
  );
}

export const ProjectGitSyncReviewContent: React.FC<
  ProjectGitSyncReviewContentProps
> = ({ orgId, orgName }) => {
  const { t } = useTranslation("projects");
  const syncResultByOrg = useAtomValue(projectGitFolderSyncResultByOrgAtom);
  const setProjectGitFolderSyncResult = useSetAtom(
    setProjectGitFolderSyncResultAtom
  );
  const syncResult = syncResultByOrg[orgId];
  const conflicts = useMemo(
    () => syncResult?.conflicts ?? [],
    [syncResult?.conflicts]
  );
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(
    null
  );
  const [editedContent, setEditedContent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const selectedConflict = useMemo(
    () =>
      conflicts.find((conflict) => conflict.id === selectedConflictId) ??
      conflicts[0] ??
      null,
    [conflicts, selectedConflictId]
  );

  useEffect(() => {
    if (!selectedConflict) {
      setSelectedConflictId(null);
      setEditedContent("");
      return;
    }
    setSelectedConflictId(selectedConflict.id);
    setEditedContent(selectedConflict.content ?? "");
  }, [selectedConflict]);

  const handleSelectConflict = useCallback(
    (conflict: ProjectGitFolderSyncConflict) => {
      setSelectedConflictId(conflict.id);
      setEditedContent(conflict.content ?? "");
    },
    []
  );

  const handleSaveResolved = useCallback(async () => {
    if (!selectedConflict) return;
    setSaving(true);
    try {
      await projectApi.resolveOrgGitFolderConflict({
        org_id: orgId,
        file_path: selectedConflict.file_path,
        content: editedContent,
      });
      Message.success(t("gitSyncReview.resolvedSaved"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Message.error(t("gitSyncReview.saveFailed", { message }));
    } finally {
      setSaving(false);
    }
  }, [editedContent, orgId, selectedConflict, t]);

  const handleSyncAgain = useCallback(async () => {
    setSyncing(true);
    try {
      const nextResult = await projectApi.syncOrgGitFolder({ org_id: orgId });
      setProjectGitFolderSyncResult(nextResult);
      if (nextResult.status === PROJECT_GIT_FOLDER_SYNC_STATUS.SYNCED) {
        Message.success(t("gitSyncReview.syncComplete"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Message.error(t("gitSyncReview.syncFailed", { message }));
    } finally {
      setSyncing(false);
    }
  }, [orgId, setProjectGitFolderSyncResult, t]);

  if (!syncResult) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("gitSyncReview.noResultTitle")}
        subtitle={t("gitSyncReview.noResultSubtitle")}
        fillParentHeight
      />
    );
  }

  if (conflicts.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("gitSyncReview.noConflictsTitle")}
        subtitle={t("gitSyncReview.noConflictsSubtitle")}
        fillParentHeight
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-1 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle size={16} className="shrink-0 text-warning-6" />
          <div className="min-w-0 truncate text-sm font-medium text-text-1">
            {t("gitSyncReview.title", { org: orgName ?? syncResult.org_id })}
          </div>
          <div className="text-warning-7 shrink-0 rounded-full bg-warning-2 px-2 py-0.5 text-xs">
            {t("gitSyncReview.conflictCount", { count: conflicts.length })}
          </div>
        </div>
        <Button
          size="small"
          appearance="ghost"
          disabled={syncing}
          onClick={() => void handleSyncAgain()}
        >
          <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
          {t("gitSyncReview.syncAgain")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border-1 bg-fill-1">
          <div className="shrink-0 px-3 py-2 text-xs font-medium uppercase tracking-wide text-text-4">
            {t("gitSyncReview.files")}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conflicts.map((conflict) => {
              const active = selectedConflict?.id === conflict.id;
              return (
                <button
                  key={conflict.id}
                  type="button"
                  className={`flex w-full flex-col rounded-md px-2 py-2 text-left transition-colors ${
                    active
                      ? "bg-fill-3 text-text-1"
                      : "text-text-2 hover:bg-fill-2"
                  }`}
                  onClick={() => handleSelectConflict(conflict)}
                >
                  <span className="truncate text-sm font-medium">
                    {conflictLabel(conflict)}
                  </span>
                  <span className="mt-0.5 truncate text-xs text-text-4">
                    {conflict.relative_path}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedConflict ? (
            <>
              <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-1 px-3">
                <div className="min-w-0 truncate text-xs text-text-3">
                  {selectedConflict.message}
                </div>
                <Button
                  size="small"
                  variant="primary"
                  disabled={saving}
                  loading={saving}
                  onClick={() => void handleSaveResolved()}
                >
                  <Check size={14} />
                  {t("gitSyncReview.saveResolved")}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {selectedConflict.kind ===
                PROJECT_GIT_FOLDER_CONFLICT_KIND.GIT_MARKER ? (
                  <CodeMirrorConflictEditor
                    content={editedContent}
                    filePath={selectedConflict.file_path}
                    onChange={setEditedContent}
                    height="100%"
                  />
                ) : (
                  <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4">
                    <div className="text-warning-7 rounded-md border border-warning-4 bg-warning-1 p-3 text-sm">
                      {selectedConflict.message}
                    </div>
                    <textarea
                      className="focus:border-accent-9 min-h-0 flex-1 resize-none rounded-md border border-border-2 bg-bg-2 p-3 text-sm text-text-1 outline-none"
                      value={editedContent}
                      onChange={(event) => setEditedContent(event.target.value)}
                    />
                  </div>
                )}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
};

export default ProjectGitSyncReviewContent;
