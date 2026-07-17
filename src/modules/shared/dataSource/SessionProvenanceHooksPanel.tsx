/**
 * SessionProvenanceHooksPanel
 *
 * The "Hooks" view of the Data Sources panel. Two stacked tables that reuse the
 * same `SettingsTable` + inline-card primitives as the "Scanning" inventory so
 * the two views read identically:
 *
 * 1. Managed hook capture — one row per supported CLI (Claude Code, Codex,
 *    Cursor, Qwen Code, Droid, Trae, OpenCode). Each row shows an install-status
 *    tag and a capture toggle; expanding it reveals an inline card with the
 *    on-disk hook config path (Copy / reveal) and the privacy note.
 * 2. Recent signals — the most recently received hook interactions
 *    (metadata only: source, action, time, file, session). The session cell
 *    resolves to a human-readable title when the session has been reconciled
 *    and links through to that session's WorkStation view. Edit signals expand
 *    to lazily load the file's diff patch when one exists.
 */
import { useAtomValue } from "jotai";
import { AlertTriangle, RefreshCw, Terminal } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type OrgtrackSessionFinalDiff,
  getOrgtrackSessionFinalDiffs,
} from "@src/api/tauri/lineage";
import { rpc } from "@src/api/tauri/rpc";
import type {
  SessionProvenanceHookPlatform,
  SessionProvenanceHookStatus,
  SessionProvenanceRecentSignal,
} from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import FileTypeIcon from "@src/components/FileTypeIcon";
import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import Tag, { type TagProps } from "@src/components/Tag";
import { INFO_CARD_TOKENS } from "@src/config/detailPanelTokens";
import { parseUnifiedDiffToOldNew } from "@src/engines/SessionCore/rendering/props/extractorShared";
import { CodeMirrorDiff } from "@src/features/CodeMirror/Diff";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import InlineInfoCard from "@src/modules/shared/layouts/blocks/InlineInfoCard";
import { TerminalService } from "@src/services/terminal";
import {
  activeWorkspaceRootPathAtom,
  primaryWorkspaceRootPathAtom,
} from "@src/store/workspace";
import { copyText } from "@src/util/data/clipboard";
import { formatRelativeElapsedShort } from "@src/util/data/formatters/date";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import { tildePath } from "./sourcePath";

interface PlatformMeta {
  id: SessionProvenanceHookPlatform;
  label: string;
  iconId: IconProvider;
}

// Display metadata for every platform ORGII can install a managed hook into.
// Order mirrors install priority: the three original harnesses, then the newer
// additions (Qwen/Droid have no importer yet; Trae/OpenCode do).
const PLATFORMS: ReadonlyArray<PlatformMeta> = [
  { id: "claude_code", label: "Claude Code", iconId: "claude_code" },
  { id: "codex", label: "Codex", iconId: "codex" },
  { id: "cursor", label: "Cursor", iconId: "cursor" },
  { id: "qwen_code", label: "Qwen Code", iconId: "qwen_code" },
  { id: "factory_droid", label: "Droid", iconId: "droid" },
  { id: "trae", label: "Trae", iconId: "trae" },
  { id: "opencode", label: "OpenCode", iconId: "opencode" },
  { id: "windsurf", label: "Windsurf", iconId: "windsurf" },
  { id: "kimi", label: "Kimi", iconId: "kimi" },
  { id: "antigravity", label: "Antigravity", iconId: "antigravity" },
  { id: "zcode", label: "ZCode", iconId: "zcode" },
];

// Map the persisted interaction `source` string to a display label + icon.
const SIGNAL_SOURCE_META: Record<
  string,
  { label: string; iconId: IconProvider }
> = {
  claude_code: { label: "Claude Code", iconId: "claude_code" },
  codex_app: { label: "Codex", iconId: "codex" },
  cursor_ide: { label: "Cursor", iconId: "cursor" },
  qwen_code: { label: "Qwen Code", iconId: "qwen_code" },
  droid: { label: "Droid", iconId: "droid" },
  trae: { label: "Trae", iconId: "trae" },
  opencode: { label: "OpenCode", iconId: "opencode" },
  windsurf: { label: "Windsurf", iconId: "windsurf" },
  kimi: { label: "Kimi", iconId: "kimi" },
  antigravity: { label: "Antigravity", iconId: "antigravity" },
  zcode: { label: "ZCode", iconId: "zcode" },
};

type StatusByPlatform = Partial<
  Record<SessionProvenanceHookPlatform, SessionProvenanceHookStatus>
>;
type ErrorByPlatform = Partial<Record<SessionProvenanceHookPlatform, string>>;

interface PlatformRow extends PlatformMeta {
  status?: SessionProvenanceHookStatus;
  error?: string;
  pending: boolean;
  loading: boolean;
}

function indexStatuses(
  statuses: SessionProvenanceHookStatus[]
): StatusByPlatform {
  return Object.fromEntries(
    statuses.map((status) => [status.platform, status])
  ) as StatusByPlatform;
}

const SourceIcon: React.FC<{ iconId: IconProvider }> = ({ iconId }) => (
  <ModelIcon
    provider={iconId}
    size={16}
    fallback={<Terminal size={16} className="text-text-3" />}
  />
);

// ── Platform capture table ──────────────────────────────────────────────────

const HookPlatformsTable: React.FC = () => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation("common");
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const primaryWorkspaceRootPath = useAtomValue(primaryWorkspaceRootPathAtom);
  const [statuses, setStatuses] = useState<StatusByPlatform>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingPlatforms, setPendingPlatforms] = useState<
    Set<SessionProvenanceHookPlatform>
  >(() => new Set());
  const [errors, setErrors] = useState<ErrorByPlatform>({});
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
  const [launchingCodexApproval, setLaunchingCodexApproval] = useState(false);
  const approvalAutoExpanded = useRef<Set<SessionProvenanceHookPlatform>>(
    new Set()
  );

  const [masterEnabled, setMasterEnabled] = useState(true);
  const [masterPending, setMasterPending] = useState(false);
  const [liveStatusEnabled, setLiveStatusEnabled] = useState(true);
  const [liveStatusPending, setLiveStatusPending] = useState(false);

  const handleMasterChange = useCallback(async (enabled: boolean) => {
    setMasterPending(true);
    const previous = !enabled;
    setMasterEnabled(enabled);
    try {
      const nextStatuses =
        await rpc.agentOrgs.sessionProvenance.setMasterEnabled({ enabled });
      setStatuses(indexStatuses(nextStatuses));
      setErrors({});
    } catch (error) {
      setMasterEnabled(previous);
      const message = error instanceof Error ? error.message : String(error);
      setErrors(
        Object.fromEntries(
          PLATFORMS.map(({ id }) => [id, message])
        ) as ErrorByPlatform
      );
    } finally {
      setMasterPending(false);
    }
  }, []);

  const handleLiveStatusChange = useCallback(async (enabled: boolean) => {
    setLiveStatusPending(true);
    const previous = !enabled;
    setLiveStatusEnabled(enabled);
    try {
      const nextStatuses =
        await rpc.agentOrgs.sessionProvenance.setLiveStatusEnabled({ enabled });
      setStatuses(indexStatuses(nextStatuses));
      setErrors({});
    } catch (error) {
      setLiveStatusEnabled(previous);
      const message = error instanceof Error ? error.message : String(error);
      setErrors(
        Object.fromEntries(
          PLATFORMS.map(({ id }) => [id, message])
        ) as ErrorByPlatform
      );
    } finally {
      setLiveStatusPending(false);
    }
  }, []);

  const loadStatuses = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [nextStatuses, nextMasterEnabled, nextLiveStatusEnabled] =
        await Promise.all([
          rpc.agentOrgs.sessionProvenance.status(),
          rpc.agentOrgs.sessionProvenance.masterEnabled(),
          rpc.agentOrgs.sessionProvenance.liveStatusEnabled(),
        ]);
      setStatuses(indexStatuses(nextStatuses));
      setMasterEnabled(nextMasterEnabled);
      setLiveStatusEnabled(nextLiveStatusEnabled);
      if (!silent) setErrors({});
    } catch (error) {
      if (silent) return;
      const message = error instanceof Error ? error.message : String(error);
      setErrors(
        Object.fromEntries(
          PLATFORMS.map(({ id }) => [id, message])
        ) as ErrorByPlatform
      );
    } finally {
      setInitialLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  useEffect(() => {
    if (statuses.codex?.activationState !== "awaiting_verification") return;
    const interval = window.setInterval(() => void loadStatuses(true), 2_000);
    return () => window.clearInterval(interval);
  }, [loadStatuses, statuses.codex?.activationState]);

  useEffect(() => {
    for (const platform of PLATFORMS) {
      const awaitingVerification =
        platform.id === "codex" &&
        statuses[platform.id]?.activationState === "awaiting_verification";
      if (
        awaitingVerification &&
        !approvalAutoExpanded.current.has(platform.id)
      ) {
        approvalAutoExpanded.current.add(platform.id);
        setExpandedRowKeys((current) =>
          current.includes(platform.id) ? current : [...current, platform.id]
        );
      } else if (!awaitingVerification) {
        approvalAutoExpanded.current.delete(platform.id);
      }
    }
  }, [statuses]);

  const handleReviewCodexHooks = useCallback(async () => {
    setLaunchingCodexApproval(true);
    setErrors((current) => ({ ...current, codex: undefined }));
    try {
      await TerminalService.executeInNewSession("codex", {
        name: "Codex hook approval",
        cwd: activeWorkspaceRootPath || primaryWorkspaceRootPath || undefined,
      });
    } catch (error) {
      setErrors((current) => ({
        ...current,
        codex: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setLaunchingCodexApproval(false);
    }
  }, [activeWorkspaceRootPath, primaryWorkspaceRootPath]);

  const handleChange = useCallback(
    async (platform: SessionProvenanceHookPlatform, enabled: boolean) => {
      const previous = statuses[platform];
      setPendingPlatforms((current) => new Set(current).add(platform));
      setErrors((current) => ({ ...current, [platform]: undefined }));
      setStatuses((current) => ({
        ...current,
        [platform]: current[platform]
          ? { ...current[platform], enabled, desiredEnabled: enabled }
          : current[platform],
      }));

      try {
        const nextStatus = await rpc.agentOrgs.sessionProvenance.setEnabled({
          platform,
          enabled,
        });
        setStatuses((current) => ({ ...current, [platform]: nextStatus }));
      } catch (error) {
        setStatuses((current) => ({ ...current, [platform]: previous }));
        setErrors((current) => ({
          ...current,
          [platform]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setPendingPlatforms((current) => {
          const next = new Set(current);
          next.delete(platform);
          return next;
        });
      }
    },
    [statuses]
  );

  const rows = useMemo<PlatformRow[]>(
    () =>
      PLATFORMS.map((platform) => ({
        ...platform,
        status: statuses[platform.id],
        error: errors[platform.id] ?? statuses[platform.id]?.error ?? undefined,
        pending: pendingPlatforms.has(platform.id),
        loading: initialLoading && !statuses[platform.id],
      })),
    [statuses, errors, pendingPlatforms, initialLoading]
  );

  const term = searchQuery.trim().toLowerCase();
  const visibleRows = term
    ? rows.filter((row) => row.label.toLowerCase().includes(term))
    : rows;

  const statusTagFor = (
    row: PlatformRow
  ): { color: TagProps["color"]; labelKey: string } => {
    if (row.loading) return { color: "processing", labelKey: "checking" };
    if (row.error) return { color: "danger", labelKey: "error" };
    const status = row.status;
    if (status && status.desiredEnabled && !status.enabled) {
      return { color: "warning", labelKey: "repair" };
    }
    if (status?.activationState === "awaiting_verification") {
      return { color: "warning", labelKey: "awaitingVerification" };
    }
    return status?.enabled
      ? { color: "success", labelKey: "on" }
      : { color: "default", labelKey: "off" };
  };

  const columns: SettingsTableColumn<PlatformRow>[] = [
    {
      key: "source",
      label: t("agentOrgs.sessionProvenance.col.source", {
        defaultValue: "Tool",
      }),
      renderCell: (row) => {
        const statusTag = statusTagFor(row);
        return (
          <span className={`${SETTINGS_TABLE_CELL.primaryIcon} min-w-0`}>
            <span className="shrink-0 text-text-2">
              <SourceIcon iconId={row.iconId} />
            </span>
            <span className="truncate">{row.label}</span>
            <span
              data-testid={`session-provenance-hook-status-${row.id}`}
              data-activation-state={row.status?.activationState ?? "inactive"}
            >
              <Tag
                size="mini"
                color={statusTag.color}
                pill
                className="shrink-0"
              >
                {t(`agentOrgs.sessionProvenance.status.${statusTag.labelKey}`, {
                  defaultValue: statusTag.labelKey,
                })}
              </Tag>
            </span>
          </span>
        );
      },
    },
    {
      key: "config",
      label: t("agentOrgs.sessionProvenance.col.config", {
        defaultValue: "Config",
      }),
      renderCell: (row) =>
        row.status?.configPath ? (
          <span
            className="block truncate text-text-3"
            title={row.status.configPath}
          >
            {tildePath(row.status.configPath)}
          </span>
        ) : null,
    },
    {
      key: "capture",
      label: t("agentOrgs.sessionProvenance.col.capture", {
        defaultValue: "Capture",
      }),
      width: SETTINGS_TABLE_COL.hug,
      align: "right",
      renderCell: (row) => (
        <div className="flex items-center justify-end">
          <Switch
            checked={row.status?.enabled ?? false}
            disabled={row.loading || !masterEnabled}
            loading={row.pending}
            ariaLabel={`${row.label} — ${t(
              "agentOrgs.sessionProvenance.capture",
              { defaultValue: "Capture file interactions" }
            )}`}
            dataTestId={`session-provenance-hook-switch-${row.id}`}
            onChange={(enabled) => void handleChange(row.id, enabled)}
          />
        </div>
      ),
    },
  ];

  const description = useCallback(
    (row: PlatformRow): string => {
      if (row.error) return row.error;
      const status = row.status;
      if (status && status.desiredEnabled && !status.enabled) {
        return t("agentOrgs.sessionProvenance.installDrift", {
          defaultValue:
            "The saved preference and installed hook differ. Toggle capture to repair the managed hook. Config: {{path}}",
          path: status.configPath,
        });
      }
      if (status?.activationState === "awaiting_verification") {
        return t("agentOrgs.sessionProvenance.codexApproval.description", {
          defaultValue:
            "Waiting for Codex to approve and execute the current ORG2 hooks.",
        });
      }
      if (status?.activationState === "active" && status.lastActivatedAt) {
        return t("agentOrgs.sessionProvenance.codexApproval.verified", {
          defaultValue: "Verified by a real Codex hook signal {{time}}.",
          time: formatRelativeElapsedShort(new Date(status.lastActivatedAt)),
        });
      }
      return t("agentOrgs.sessionProvenance.description", {
        defaultValue:
          "Records file reads and writes as metadata. Prompts, tool output, and file contents are not stored.",
      });
    },
    [t]
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionContainer>
        <SectionRow
          label={t("agentOrgs.sessionProvenance.masterToggle", {
            defaultValue: "Provenance hooks",
          })}
          description={t("agentOrgs.sessionProvenance.masterToggleDesc", {
            defaultValue:
              "When off, all managed hooks are uninstalled and no signals are captured",
          })}
        >
          <Switch
            checked={masterEnabled}
            loading={masterPending}
            onChange={(enabled) => void handleMasterChange(enabled)}
            ariaLabel={t("agentOrgs.sessionProvenance.masterToggle", {
              defaultValue: "Provenance hooks",
            })}
          />
        </SectionRow>
        <SectionRow
          label={t("agentOrgs.sessionProvenance.liveStatusToggle", {
            defaultValue: "Live agent status",
          })}
          description={t("agentOrgs.sessionProvenance.liveStatusToggleDesc", {
            defaultValue:
              "Installs lifecycle events (prompt, tool, permission, stop) so running CLI sessions show live working/waiting status. Off keeps provenance capture only.",
          })}
        >
          <Switch
            checked={liveStatusEnabled}
            loading={liveStatusPending}
            disabled={!masterEnabled}
            onChange={(enabled) => void handleLiveStatusChange(enabled)}
            ariaLabel={t("agentOrgs.sessionProvenance.liveStatusToggle", {
              defaultValue: "Live agent status",
            })}
          />
        </SectionRow>
      </SectionContainer>
      <SettingsTable<PlatformRow>
        columns={columns}
        rows={visibleRows}
        getRowKey={(row) => row.id}
        headerHeight="tall"
        inlineHeaderToolbar
        className="table-expanded-no-hover table-settings-expanded-compact"
        hover
        loading={initialLoading && rows.every((row) => !row.status)}
        emptyTitle={term ? tCommon("status.noResults") : undefined}
        searchBar={{
          searchValue: searchQuery,
          searchPlaceholder: tCommon("common.searchPlaceholder"),
          onSearchChange: setSearchQuery,
          onSearchClear: () => setSearchQuery(""),
          searchInputSize: "default",
          rightContent: (
            <Button
              variant="secondary"
              size="default"
              loading={refreshing}
              icon={<RefreshCw size={14} />}
              onClick={() => void loadStatuses()}
            >
              {tCommon("actions.refresh")}
            </Button>
          ),
        }}
        expandable={{
          expandedRowRender: (row) => (
            <InlineInfoCard
              dataTestId={`session-provenance-hook-card-${row.id}`}
            >
              <div className={`grid ${INFO_CARD_TOKENS.rowGap}`}>
                <div className="flex items-start justify-between gap-3">
                  <span className={`${INFO_CARD_TOKENS.label} pt-1`}>
                    {t("agentOrgs.sessionProvenance.col.config", {
                      defaultValue: "Config",
                    })}
                  </span>
                  {row.status?.configPath ? (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="min-w-0 truncate text-[12px] text-text-1"
                        title={row.status.configPath}
                      >
                        {tildePath(row.status.configPath)}
                      </span>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => void copyText(row.status!.configPath)}
                      >
                        {t("agentOrgs.sessionProvenance.copyPath", {
                          defaultValue: "Copy",
                        })}
                      </Button>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() =>
                          openFileInWorkStation(row.status!.configPath)
                        }
                      >
                        {tCommon("actions.open")}
                      </Button>
                    </div>
                  ) : (
                    <span className={INFO_CARD_TOKENS.value}>—</span>
                  )}
                </div>
                <p className="text-[12px] leading-relaxed text-text-2">
                  {description(row)}
                </p>
                {row.id === "codex" &&
                  row.status?.activationState === "awaiting_verification" && (
                    <div
                      className="flex items-start justify-between gap-4 rounded-md border border-warning-3 bg-warning-1 px-3 py-2.5"
                      data-testid="session-provenance-codex-approval"
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        <AlertTriangle
                          size={16}
                          className="mt-0.5 shrink-0 text-warning-6"
                        />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-text-1">
                            {t(
                              "agentOrgs.sessionProvenance.codexApproval.title",
                              { defaultValue: "Verify ORG2 hooks in Codex" }
                            )}
                          </p>
                          <p className="mt-0.5 text-[12px] leading-relaxed text-text-2">
                            {t(
                              "agentOrgs.sessionProvenance.codexApproval.instructions",
                              {
                                defaultValue:
                                  "Open Codex, review the ORG2 hooks, then choose Trust all and continue. The SessionStart hook verifies activation automatically when the session starts.",
                              }
                            )}
                          </p>
                        </div>
                      </div>
                      <span data-testid="session-provenance-review-codex-hooks">
                        <Button
                          variant="primary"
                          size="small"
                          icon={<Terminal size={14} />}
                          loading={launchingCodexApproval}
                          onClick={() => void handleReviewCodexHooks()}
                        >
                          {t(
                            "agentOrgs.sessionProvenance.codexApproval.review",
                            {
                              defaultValue: "Review in Codex",
                            }
                          )}
                        </Button>
                      </span>
                    </div>
                  )}
              </div>
            </InlineInfoCard>
          ),
          rowExpandable: () => true,
          expandedRowKeys,
          onExpandedRowsChange: setExpandedRowKeys,
        }}
      />
    </div>
  );
};

// ── Recent signals table ────────────────────────────────────────────────────

const ACTION_TAG_COLOR: Record<string, TagProps["color"]> = {
  read: "default",
  write: "processing",
  create: "success",
  delete: "danger",
  rename: "warning",
  search: "default",
};

// Max render width (px) for the path columns; content past this is truncated.
const PATH_COL_MAX_PX = 300;
const WORKSPACE_COL_MAX_PX = 200;

/**
 * Collapse the middle of a long path to `/.../`, keeping the leading segment and
 * the trailing file (plus its parent dir when it fits) so both ends stay
 * readable. Paths within `maxChars` are returned unchanged.
 */
function middleTruncatePath(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) {
    const keep = Math.max(6, maxChars - 5);
    const head = Math.ceil(keep / 2);
    return `${path.slice(0, head)}/.../${path.slice(path.length - (keep - head))}`;
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  const withParent = `${first}/.../${segments.slice(-2).join("/")}`;
  if (withParent.length <= maxChars) return withParent;
  const fileOnly = `${first}/.../${last}`;
  if (fileOnly.length <= maxChars) return fileOnly;
  const budget = Math.max(6, maxChars - first.length - 5);
  return `${first}/.../${last.slice(last.length - budget)}`;
}

// Only mutating actions can carry a patch; reads/searches never do.
const EDIT_ACTIONS = new Set(["write", "create", "delete", "rename"]);

// Signal `filePath` is repo-relative; a final-diff `filePath` may be absolute or
// workspace-relative. Match on normalized trailing path segments.
function diffMatchesFile(diffPath: string, signalPath: string): boolean {
  const a = diffPath.replace(/\\/g, "/");
  const b = signalPath.replace(/\\/g, "/");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

type SignalDiffState =
  | { status: "loading" }
  | { status: "empty" }
  | {
      status: "ready";
      oldValue: string;
      newValue: string;
      oldStartLine?: number;
      newStartLine?: number;
    };

/**
 * Expanded-row content for one edit signal. Lazily loads the session's final
 * diffs (deduped per session) and renders the matching file's patch. Session
 * provenance stores metadata only, so a patch exists solely for sources whose
 * transcript has been imported/reconciled (native + importable CLIs) — hence the
 * graceful empty state for hook-only sources and not-yet-imported sessions.
 */
const SignalDiffCard: React.FC<{
  signal: SessionProvenanceRecentSignal;
  fetchDiffs: (
    source: string,
    sessionId: string
  ) => Promise<OrgtrackSessionFinalDiff[]>;
}> = ({ signal, fetchDiffs }) => {
  const { t } = useTranslation("integrations");
  const [state, setState] = useState<SignalDiffState>({ status: "loading" });

  useEffect(() => {
    // Each expanded row mounts a fresh card (rows are content-keyed), so the
    // initial "loading" state already holds — no synchronous reset needed.
    let cancelled = false;
    fetchDiffs(signal.source, signal.sessionId)
      .then((diffs) => {
        if (cancelled) return;
        const match = diffs.find((diff) =>
          diffMatchesFile(diff.filePath, signal.filePath)
        );
        if (match?.diff) {
          const parsed = parseUnifiedDiffToOldNew(match.diff);
          setState({
            status: "ready",
            oldValue: parsed.oldValue,
            newValue: parsed.newValue,
            oldStartLine: parsed.oldStartLine,
            newStartLine: parsed.newStartLine,
          });
        } else if (
          match &&
          (match.oldContent != null || match.newContent != null)
        ) {
          setState({
            status: "ready",
            oldValue: match.oldContent ?? "",
            newValue: match.newContent ?? "",
          });
        } else {
          setState({ status: "empty" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "empty" });
      });
    return () => {
      cancelled = true;
    };
  }, [signal.source, signal.sessionId, signal.filePath, fetchDiffs]);

  return (
    <InlineInfoCard dataTestId="session-provenance-signal-diff">
      {state.status === "loading" ? (
        <p className="text-[12px] text-text-3">
          {t("agentOrgs.sessionProvenance.signals.diffLoading", {
            defaultValue: "Loading patch…",
          })}
        </p>
      ) : state.status === "empty" ? (
        <p className="text-[12px] leading-relaxed text-text-3">
          {t("agentOrgs.sessionProvenance.signals.diffEmpty", {
            defaultValue:
              "No patch captured. Provenance records file changes as metadata; a diff appears only once this session's edits are imported.",
          })}
        </p>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <CodeMirrorDiff
            oldValue={state.oldValue}
            newValue={state.newValue}
            filePath={signal.filePath}
            viewMode="unified"
            readOnly
            autoHeight
            oldStartLine={state.oldStartLine}
            newStartLine={state.newStartLine}
          />
        </div>
      )}
    </InlineInfoCard>
  );
};

const RecentSignalsTable: React.FC = () => {
  const { t } = useTranslation("integrations");
  const { openSession } = useSessionView();
  const [signals, setSignals] = useState<
    SessionProvenanceRecentSignal[] | null
  >(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
  // Dedupe per-session final-diff fetches across expanded rows.
  const diffCache = useRef(
    new Map<string, Promise<OrgtrackSessionFinalDiff[]>>()
  );
  const fetchDiffs = useCallback((source: string, sessionId: string) => {
    const key = `${source}::${sessionId}`;
    let pending = diffCache.current.get(key);
    if (!pending) {
      pending = getOrgtrackSessionFinalDiffs({ source, sessionId }).catch(
        () => []
      );
      diffCache.current.set(key, pending);
    }
    return pending;
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    // Drop cached diffs so a manual refresh re-reads newly imported patches.
    diffCache.current.clear();
    try {
      const next = await rpc.agentOrgs.sessionProvenance.recentSignals({
        limit: 50,
      });
      setSignals(next);
    } catch {
      setSignals([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sourceMeta = (source: string) =>
    SIGNAL_SOURCE_META[source] ?? {
      label: source,
      iconId: source as IconProvider,
    };

  const columns: SettingsTableColumn<SessionProvenanceRecentSignal>[] = [
    {
      key: "source",
      label: t("agentOrgs.sessionProvenance.signals.col.source", {
        defaultValue: "Tool",
      }),
      width: SETTINGS_TABLE_COL.valueLg,
      renderCell: (row) => {
        const meta = sourceMeta(row.source);
        return (
          <span className={`${SETTINGS_TABLE_CELL.primaryIcon} min-w-0`}>
            <span className="shrink-0 text-text-2">
              <SourceIcon iconId={meta.iconId} />
            </span>
            <span className="truncate">{meta.label}</span>
          </span>
        );
      },
    },
    {
      key: "action",
      label: t("agentOrgs.sessionProvenance.signals.col.action", {
        defaultValue: "Action",
      }),
      width: SETTINGS_TABLE_COL.valueMd,
      renderCell: (row) => (
        <Tag size="mini" color={ACTION_TAG_COLOR[row.action] ?? "default"} pill>
          {t(`agentOrgs.sessionProvenance.signals.action.${row.action}`, {
            defaultValue: row.action,
          })}
        </Tag>
      ),
    },
    {
      key: "when",
      label: t("agentOrgs.sessionProvenance.signals.col.when", {
        defaultValue: "When",
      }),
      width: SETTINGS_TABLE_COL.valueMd,
      sorter: (a, b) => a.occurredAt.localeCompare(b.occurredAt),
      renderCell: (row) => (
        <span className="whitespace-nowrap text-text-3" title={row.occurredAt}>
          {formatRelativeElapsedShort(new Date(row.occurredAt))}
        </span>
      ),
    },
    {
      key: "workspace",
      label: t("agentOrgs.sessionProvenance.signals.col.workspace", {
        defaultValue: "Workspace",
      }),
      width: `${WORKSPACE_COL_MAX_PX}px`,
      renderCell: (row) => {
        const full = tildePath(row.workspacePath);
        return (
          <span
            className="block truncate whitespace-nowrap text-text-3"
            style={{ maxWidth: WORKSPACE_COL_MAX_PX }}
            title={row.workspacePath}
          >
            {middleTruncatePath(full, 28)}
          </span>
        );
      },
    },
    {
      key: "file",
      label: t("agentOrgs.sessionProvenance.signals.col.file", {
        defaultValue: "File",
      }),
      width: `${PATH_COL_MAX_PX}px`,
      renderCell: (row) => {
        const display = middleTruncatePath(row.filePath, 42);
        const slash = display.lastIndexOf("/");
        const dir = slash >= 0 ? display.slice(0, slash + 1) : "";
        const name = slash >= 0 ? display.slice(slash + 1) : display;
        return (
          <span
            className="flex items-center gap-1.5 overflow-hidden"
            style={{ maxWidth: PATH_COL_MAX_PX }}
            title={row.filePath}
          >
            <FileTypeIcon
              fileName={row.filePath}
              size="small"
              className="shrink-0"
            />
            <span className="truncate whitespace-nowrap">
              {dir ? <span className="text-text-3">{dir}</span> : null}
              <span className="text-text-2">{name}</span>
            </span>
          </span>
        );
      },
    },
    {
      key: "session",
      label: t("agentOrgs.sessionProvenance.signals.col.session", {
        defaultValue: "Session",
      }),
      width: `${PATH_COL_MAX_PX}px`,
      renderCell: (row) => {
        const title = row.sessionTitle?.trim();
        const label = title || row.sessionId;
        const tone = title
          ? "text-text-2"
          : "font-mono text-[12px] text-text-3";
        return (
          <button
            type="button"
            onClick={() =>
              openSession(row.sessionId, title || undefined, row.workspacePath)
            }
            title={row.sessionId}
            aria-label={t("agentOrgs.sessionProvenance.signals.openSession", {
              defaultValue: "Open session {{session}}",
              session: label,
            })}
            style={{ maxWidth: PATH_COL_MAX_PX }}
            className={`flex min-w-0 max-w-full items-center text-left hover:text-text-1 hover:underline focus-visible:underline ${tone}`}
          >
            <span className="truncate">{label}</span>
          </button>
        );
      },
    },
  ];

  const term = searchQuery.trim().toLowerCase();
  const rows = (signals ?? []).filter((row) =>
    term
      ? [
          row.source,
          row.filePath,
          row.workspacePath,
          row.sessionId,
          row.sessionTitle,
          row.action,
        ]
          .join(" ")
          .toLowerCase()
          .includes(term)
      : true
  );

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="session-provenance-recent-signals"
    >
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[13px] font-semibold text-text-1">
          {t("agentOrgs.sessionProvenance.signals.title", {
            defaultValue: "Recent signals",
          })}
        </h3>
      </div>
      <SettingsTable<SessionProvenanceRecentSignal>
        columns={columns}
        rows={rows}
        getRowKey={(row) =>
          `${row.source}:${row.sessionId}:${row.filePath}:${row.action}:${row.occurredAt}:${row.captureMethod}`
        }
        headerHeight="tall"
        inlineHeaderToolbar
        hover
        loading={signals === null}
        expandable={{
          expandedRowRender: (row) => (
            <SignalDiffCard signal={row} fetchDiffs={fetchDiffs} />
          ),
          // Only edit signals can carry a patch; reads/searches stay flat.
          rowExpandable: (row) => EDIT_ACTIONS.has(row.action),
          expandedRowKeys,
          onExpandedRowsChange: setExpandedRowKeys,
        }}
        emptyTitle={
          term
            ? t("agentOrgs.sessionProvenance.signals.noResults", {
                defaultValue: "No matching signals",
              })
            : t("agentOrgs.sessionProvenance.signals.empty", {
                defaultValue: "No hook signals received yet.",
              })
        }
        searchBar={{
          searchValue: searchQuery,
          searchPlaceholder: t("agentOrgs.sessionProvenance.signals.search", {
            defaultValue: "Search signals",
          }),
          onSearchChange: setSearchQuery,
          onSearchClear: () => setSearchQuery(""),
          searchInputSize: "default",
          rightContent: (
            <Button
              variant="secondary"
              size="default"
              loading={refreshing}
              icon={<RefreshCw size={14} />}
              onClick={() => void load()}
            >
              {t("agentOrgs.sessionProvenance.signals.refresh", {
                defaultValue: "Refresh",
              })}
            </Button>
          ),
        }}
      />
    </div>
  );
};

const SessionProvenanceHooksPanel: React.FC = () => {
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="session-provenance-hooks-panel"
    >
      <HookPlatformsTable />
      <RecentSignalsTable />
    </div>
  );
};

export default SessionProvenanceHooksPanel;
