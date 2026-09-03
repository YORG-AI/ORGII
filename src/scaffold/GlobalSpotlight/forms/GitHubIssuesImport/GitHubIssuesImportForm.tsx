import { emit } from "@tauri-apps/api/event";
import { useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_SYNC_ADAPTER,
  type SyncConnection,
  syncConnectionsApi,
} from "@src/api/http/integrations/syncConnections";
import { projectApi } from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import { Message } from "@src/components/Message";
import Select, { type SelectOption } from "@src/components/Select";
import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation/tabs";

import { SpotlightSearchBar } from "../../components";
import { ICONS } from "../../config";
import type { PathSegment } from "../../types";
import { SpotlightFormBody, SpotlightFormShell } from "../shared";
import {
  createProjectSlug,
  createWorkItemPrefix,
  formatGitHubRepoInput,
  parseGitHubRepo,
} from "./githubIssuesImport";

interface GitHubIssuesImportFormProps {
  orgId?: string;
  repoName?: string;
  repoPath?: string;
  repoUrl?: string;
  onCancel: () => void;
  onImported: () => void;
}

const logger = createLogger("GitHubIssuesImportForm");

const GitHubIssuesImportForm: React.FC<GitHubIssuesImportFormProps> = ({
  orgId = STORY_PERSONAL_ORG_FILTER_ID,
  repoName,
  repoPath,
  repoUrl,
  onCancel,
  onImported,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const [projectName, setProjectName] = useState(() =>
    repoName ? `${repoName} issues` : ""
  );
  const [repoInput, setRepoInput] = useState(() =>
    formatGitHubRepoInput(repoUrl)
  );
  const [connectionId, setConnectionId] = useState("");
  const [connections, setConnections] = useState<SyncConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [repoInputTouched, setRepoInputTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadConnections() {
      try {
        const allConnections = await syncConnectionsApi.list();
        if (cancelled) return;
        const githubConnections = allConnections.filter(
          (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.GITHUB
        );
        setConnections(githubConnections);
        setConnectionId(githubConnections[0]?.id ?? "");
      } catch (error) {
        logger.error("Failed to load GitHub sync connections", error);
        Message.error(formatErrorMessage(error));
      } finally {
        if (!cancelled) setConnectionsLoading(false);
      }
    }

    void loadConnections();
    return () => {
      cancelled = true;
    };
  }, []);

  const parsedRepo = useMemo(() => parseGitHubRepo(repoInput), [repoInput]);
  const repoError =
    repoInput.trim() && !parsedRepo && (repoInputTouched || submitAttempted)
      ? t("projects:githubIssuesImport.errors.invalidRepo")
      : undefined;
  const connectionOptions = useMemo<SelectOption[]>(
    () =>
      connections.map((connection) => ({
        value: connection.id,
        label: connection.label,
        triggerLabel: connection.label,
      })),
    [connections]
  );
  const canSubmit = Boolean(
    projectName.trim() && parsedRepo && connectionId && !saving
  );
  const title = t("projects:githubIssuesImport.title");
  const path = useMemo<PathSegment[]>(
    () => [
      {
        type: "action",
        id: "import-github-issues",
        label: title,
        icon: ICONS.github,
        color: "primary",
      },
    ],
    [title]
  );

  const handleClear = useCallback(() => {
    setProjectName("");
    setRepoInput("");
    setConnectionId("");
    setRepoInputTouched(false);
    setSubmitAttempted(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitAttempted(true);
    if (!canSubmit || !parsedRepo) return;

    setSaving(true);
    try {
      const name = projectName.trim();
      const slug = createProjectSlug(name);
      const now = new Date().toISOString();
      const description = t("projects:githubIssuesImport.projectDescription", {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
      });

      await projectApi.writeProject(
        slug,
        {
          id: `proj-${slug}`,
          name,
          org_id: orgId,
          status: "backlog",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: repoPath ? [repoPath] : [],
          created_at: now,
          updated_at: now,
          next_work_item_id: 1,
          work_item_prefix: createWorkItemPrefix(name),
          work_item_prefix_custom: false,
        },
        description,
        true
      );

      await projectSyncApi.attachAdapter(
        slug,
        STORY_SYNC_ADAPTER.GITHUB,
        connectionId,
        JSON.stringify({ owner: parsedRepo.owner, repo: parsedRepo.repo })
      );

      await emit("orgii-data-changed");
      bumpProjectListRefresh((previous) => previous + 1);
      onImported();
    } catch (error) {
      logger.error("Failed to import GitHub issues project", error);
      Message.error(formatErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [
    canSubmit,
    bumpProjectListRefresh,
    connectionId,
    onImported,
    orgId,
    parsedRepo,
    projectName,
    repoPath,
    t,
  ]);

  return (
    <div data-testid="github-issues-import-spotlight">
      <SpotlightSearchBar
        inputRef={hiddenInputRef}
        searchQuery=""
        onSearchQueryChange={() => undefined}
        onKeyDown={() => undefined}
        placeholder=""
        path={path}
        onRemoveSegment={onCancel}
        hideInput
      />
      <form
        data-testid="github-issues-import-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <SpotlightFormShell>
          <SpotlightFormBody>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-sm text-text-2">
                <span>
                  {t("projects:githubIssuesImport.fields.projectName")}
                  <span className="text-danger-6" aria-hidden>
                    *
                  </span>
                </span>
                <Input
                  value={projectName}
                  onChange={setProjectName}
                  aria-label={t(
                    "projects:githubIssuesImport.fields.projectName"
                  )}
                  placeholder={t(
                    "projects:githubIssuesImport.placeholders.projectName"
                  )}
                  size="default"
                  autoFocus
                  required
                />
              </label>

              <label className="flex flex-col gap-2 text-sm text-text-2">
                <span>
                  {t("projects:githubIssuesImport.fields.repo")}
                  <span className="text-danger-6" aria-hidden>
                    *
                  </span>
                </span>
                <Input
                  value={repoInput}
                  onChange={(value) => {
                    setRepoInput(value);
                    if (parseGitHubRepo(value)) setRepoInputTouched(false);
                  }}
                  onBlur={() => setRepoInputTouched(true)}
                  aria-label={t("projects:githubIssuesImport.fields.repo")}
                  placeholder={t(
                    "projects:githubIssuesImport.placeholders.repo"
                  )}
                  errorMessage={repoError}
                  size="default"
                  required
                />
              </label>

              <div className="flex flex-col gap-2 text-sm text-text-2">
                <span>
                  {t("projects:githubIssuesImport.fields.connection")}
                  <span className="text-danger-6" aria-hidden>
                    *
                  </span>
                </span>
                {connectionsLoading ? (
                  <div className="flex h-8 items-center gap-2 rounded-lg border border-border-2 px-3 text-sm text-text-3">
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      data-icon="loader-2"
                      size={14}
                      className="animate-spin"
                    />
                    {t("projects:githubIssuesImport.loadingConnections")}
                  </div>
                ) : connectionOptions.length > 0 ? (
                  <Select
                    value={connectionId}
                    options={connectionOptions}
                    ariaLabel={t(
                      "projects:githubIssuesImport.fields.connection"
                    )}
                    onChange={(value) => {
                      if (!Array.isArray(value)) {
                        setConnectionId(String(value));
                      }
                    }}
                    placeholder={t(
                      "projects:githubIssuesImport.placeholders.connection"
                    )}
                    size="default"
                    showSearch
                  />
                ) : (
                  <InlineAlert
                    type="warning"
                    title={t("projects:githubIssuesImport.noConnectionTitle")}
                  >
                    {t("projects:githubIssuesImport.noConnectionDescription")}
                  </InlineAlert>
                )}
              </div>

              {repoName ? (
                <p className="text-xs text-text-3">
                  {t("projects:githubIssuesImport.linkedRepoHint", {
                    repoName,
                  })}
                </p>
              ) : null}
            </div>
          </SpotlightFormBody>
          <PanelFooter
            secondaryActions={[
              {
                label: t("common:actions.clear"),
                onClick: handleClear,
                disabled: saving,
                htmlType: "button",
              },
            ]}
            primaryAction={{
              label: t("projects:githubIssuesImport.importButton"),
              disabled: !canSubmit,
              loading: saving,
              htmlType: "submit",
              dataTestId: "github-issues-import-submit",
            }}
          />
        </SpotlightFormShell>
      </form>
    </div>
  );
};

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default GitHubIssuesImportForm;
