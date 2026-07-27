/**
 * GitHubIssuesImportWizard
 *
 * Chat-panel wizard for creating an ORGII project backed by a GitHub repo's
 * issues. The wizard creates the project, attaches the GitHub sync adapter with
 * `{ owner, repo }`, then lets the backend import issues asynchronously.
 */
import { emit } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_SYNC_ADAPTER,
  type SyncConnection,
  syncConnectionsApi,
} from "@src/api/http/integrations/syncConnections";
import { projectApi } from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import { Message } from "@src/components/Message";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { createLogger } from "@src/hooks/logger";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import WizardShell from "@src/scaffold/WizardSystem/primitives/WizardShell";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation/tabs";

interface GitHubIssuesImportWizardProps {
  repoPath?: string | null;
  repoName?: string;
  orgId?: string;
  onCancel: () => void;
  onProjectCreated: (options?: { keepOpen?: boolean }) => void;
}

interface ParsedGitHubRepo {
  owner: string;
  repo: string;
}

const logger = createLogger("GitHubIssuesImportWizard");

const DEFAULT_PROJECT_NAME = "ORGII issues";
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const GitHubIssuesImportWizard: React.FC<GitHubIssuesImportWizardProps> = ({
  repoPath,
  repoName,
  orgId = STORY_PERSONAL_ORG_FILTER_ID,
  onCancel,
  onProjectCreated,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  const [repoInput, setRepoInput] = useState("ORGII/ORGII");
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
        setConnectionId((current) => current || githubConnections[0]?.id || "");
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
  const shouldShowRepoError =
    Boolean(repoInput.trim()) &&
    !parsedRepo &&
    (repoInputTouched || submitAttempted);
  const repoError = shouldShowRepoError
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
      onProjectCreated();
    } catch (error) {
      logger.error("Failed to import GitHub issues project", error);
      Message.error(formatErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [
    canSubmit,
    connectionId,
    onProjectCreated,
    orgId,
    parsedRepo,
    projectName,
    repoPath,
    t,
  ]);

  return (
    <WizardShell
      title={t("projects:githubIssuesImport.title")}
      onCancel={onCancel}
      testId="github-issues-import-wizard"
    >
      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <div
            className={`${DETAIL_PANEL_TOKENS.headerWidth} flex h-full flex-col gap-4 overflow-y-auto px-4`}
            data-testid="github-issues-import-form"
          >
            <SectionContainer>
              <SectionRow
                label={t("projects:githubIssuesImport.fields.projectName")}
                layout="vertical"
                required
              >
                <Input
                  value={projectName}
                  onChange={setProjectName}
                  placeholder={t(
                    "projects:githubIssuesImport.placeholders.projectName"
                  )}
                  size="default"
                  autoFocus
                />
              </SectionRow>
              <SectionRow
                label={t("projects:githubIssuesImport.fields.repo")}
                layout="vertical"
                required
              >
                <Input
                  value={repoInput}
                  onChange={(value) => {
                    setRepoInput(value);
                    if (parsedRepo) setRepoInputTouched(false);
                  }}
                  onBlur={() => setRepoInputTouched(true)}
                  placeholder={t(
                    "projects:githubIssuesImport.placeholders.repo"
                  )}
                  errorMessage={repoError}
                  size="default"
                />
              </SectionRow>
              <SectionRow
                label={t("projects:githubIssuesImport.fields.connection")}
                layout="vertical"
                required
              >
                {connectionsLoading ? (
                  <div className="flex h-8 items-center gap-2 rounded-lg border border-border-2 px-3 text-[13px] text-text-3">
                    <Loader2 size={14} className="animate-spin" />
                    {t("projects:githubIssuesImport.loadingConnections")}
                  </div>
                ) : connectionOptions.length > 0 ? (
                  <Select
                    value={connectionId}
                    options={connectionOptions}
                    onChange={(value) => {
                      if (!Array.isArray(value)) setConnectionId(String(value));
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
              </SectionRow>
              <SectionRow showHeader={false}>
                <div className="flex w-full justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={handleClear}
                    disabled={saving}
                  >
                    {t("common:actions.clear")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={() => void handleSubmit()}
                    loading={saving}
                    disabled={!canSubmit}
                  >
                    {t("projects:githubIssuesImport.importButton")}
                  </Button>
                </div>
              </SectionRow>
            </SectionContainer>

            {repoName ? (
              <p className="text-[12px] text-text-3">
                {t("projects:githubIssuesImport.linkedRepoHint", {
                  repoName,
                })}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </WizardShell>
  );
};

function parseGitHubRepo(input: string): ParsedGitHubRepo | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let path = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return null;
    path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  } catch {
    path = trimmed.replace(/^github\.com\//, "").replace(/\.git$/, "");
  }

  if (!GITHUB_REPO_PATTERN.test(path)) return null;
  const [owner, repo] = path.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

function createProjectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "github-issues";
}

function createWorkItemPrefix(name: string): string {
  const prefix = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return prefix ? prefix.slice(0, 3).padEnd(3, "X") : "GHI";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default GitHubIssuesImportWizard;
