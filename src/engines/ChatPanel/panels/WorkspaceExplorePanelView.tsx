/**
 * WorkspaceExplorePanelView
 *
 * "Explore" tab: GitHub repository search surface that lives in the chat
 * panel slot alongside the workspace dashboard, sticky notes, project,
 * and work-item views. Reuses the user's connection token when one is on
 * file (5000 req/h limit) and falls back to unauthenticated search
 * otherwise (10 req/min limit).
 *
 * The Clone button runs the `repo.clone` zod action against the user's
 * default workspace parent directory — same code path the Spotlight
 * clone form uses — so cloned repos automatically register as ORGII
 * workspaces.
 */
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useAtomValue } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { zodActionRegistry } from "@src/ActionSystem/schema/zodRegistry";
import {
  type RepoSearchResponse,
  type RepoSearchSort,
  type SearchRepo,
  searchReposLocal,
} from "@src/api/tauri/github";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import TabPill from "@src/components/TabPill";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { createLogger } from "@src/hooks/logger";
import {
  Download01Icon,
  GitForkIcon,
  HugeiconsIcon,
  Search01Icon,
  SquareArrowUpRightIcon,
  StarIcon,
} from "@src/icons";
import {
  effectiveWorkspaceDefaultRepoLocationAtom,
  workspaceCustomDefaultRepoPathAtom,
} from "@src/store/config/configAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { resolveDefaultRepoParentPath } from "@src/util/workspace/defaultRepoPath";

const logger = createLogger("WorkspaceExplorePanelView");

const SORT_VALUES: RepoSearchSort[] = [
  "best_match",
  "stars",
  "updated",
  "forks",
];

function formatStarCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toString();
}

function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const elapsed = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;
  if (elapsed < hour)
    return `${Math.max(1, Math.round(elapsed / minute))}m ago`;
  if (elapsed < day) return `${Math.round(elapsed / hour)}h ago`;
  if (elapsed < month) return `${Math.round(elapsed / day)}d ago`;
  if (elapsed < year) return `${Math.round(elapsed / month)}mo ago`;
  return `${Math.round(elapsed / year)}y ago`;
}

interface SearchRepoCardProps {
  repo: SearchRepo;
  onOpen: (repo: SearchRepo) => void;
  onClone: (repo: SearchRepo) => void;
  cloningKey: string | null;
}

const SearchRepoCard: React.FC<SearchRepoCardProps> = ({
  repo,
  onOpen,
  onClone,
  cloningKey,
}) => {
  const { t } = useTranslation("navigation");
  const cloning = cloningKey === repo.full_name;
  return (
    <div className="group border-b border-border-2 py-3">
      <div className="flex items-start gap-3">
        <img
          src={repo.owner_avatar_url}
          alt=""
          className="h-8 w-8 shrink-0 rounded-full"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="truncate text-[13px] font-medium text-text-1">
              {repo.full_name}
            </span>
            {repo.archived ? (
              <span className="rounded bg-warning-2 px-1 py-px text-[10px] uppercase text-warning-6">
                archived
              </span>
            ) : null}
            {repo.fork ? (
              <span className="text-[11px] text-text-3">· fork</span>
            ) : null}
          </div>
          {repo.description ? (
            <p className="mt-0.5 line-clamp-2 text-[12px] text-text-2">
              {repo.description}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-3">
            {repo.language ? <span>{repo.language}</span> : null}
            <span className="inline-flex items-center gap-1">
              <HugeiconsIcon
                icon={StarIcon}
                data-icon="star"
                size={11}
                strokeWidth={1.75}
              />
              {formatStarCount(repo.stargazers_count)}
            </span>
            <span className="inline-flex items-center gap-1">
              <HugeiconsIcon
                icon={GitForkIcon}
                data-icon="git-fork"
                size={11}
                strokeWidth={1.75}
              />
              {formatStarCount(repo.forks_count)}
            </span>
            {repo.license ? <span>{repo.license}</span> : null}
            {repo.updated_at ? (
              <span>{formatRelativeTime(repo.updated_at)}</span>
            ) : null}
          </div>
          {repo.topics.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {repo.topics.slice(0, 6).map((topic) => (
                <span
                  key={topic}
                  className="rounded-full bg-fill-1 px-2 py-px text-[10px] text-text-2"
                >
                  {topic}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="pointer-events-none flex shrink-0 items-center gap-1.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            variant="tertiary"
            size="small"
            shape="circle"
            iconOnly
            icon={
              <HugeiconsIcon
                icon={SquareArrowUpRightIcon}
                data-icon="square-arrow-out-up-right"
                size={13}
              />
            }
            onClick={() => onOpen(repo)}
            aria-label={t("explore.openOnGithub", { defaultValue: "GitHub" })}
          />
          <Button
            variant="primary"
            size="small"
            shape="circle"
            iconOnly
            icon={
              <HugeiconsIcon
                icon={Download01Icon}
                data-icon="download"
                size={13}
              />
            }
            onClick={() => onClone(repo)}
            disabled={cloning}
            aria-label={
              cloning
                ? t("explore.cloning", { defaultValue: "Cloning..." })
                : t("explore.clone", { defaultValue: "Clone" })
            }
          />
        </div>
      </div>
    </div>
  );
};

const WorkspaceExplorePanelView: React.FC = () => {
  const { t } = useTranslation("navigation");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RepoSearchSort>("best_match");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<RepoSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloningKey, setCloningKey] = useState<string | null>(null);

  const defaultRepoLocation = useAtomValue(
    effectiveWorkspaceDefaultRepoLocationAtom
  );
  const customDefaultRepoPath = useAtomValue(
    workspaceCustomDefaultRepoPathAtom
  );
  const isMaximized = useAtomValue(chatPanelMaximizedAtom);
  const titleSizeClass = isMaximized ? "text-[18px]" : "text-[16px]";

  const runSearch = useCallback(
    async (nextSort: RepoSearchSort = sort) => {
      const trimmed = query.trim();
      if (!trimmed) {
        setResponse(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await searchReposLocal(trimmed, {
          sort: nextSort,
          page: 1,
          perPage: 25,
        });
        setResponse(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("search failed:", message);
        setError(message);
        setResponse(null);
      } finally {
        setLoading(false);
      }
    },
    [query, sort]
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void runSearch();
    },
    [runSearch]
  );

  const handleSortChange = useCallback(
    (next: RepoSearchSort) => {
      setSort(next);
      if (query.trim()) void runSearch(next);
    },
    [query, runSearch]
  );

  const handleOpen = useCallback((repo: SearchRepo) => {
    void openExternal(repo.html_url).catch((err) => {
      logger.warn("failed to open repo URL:", err);
    });
  }, []);

  const handleClone = useCallback(
    async (repo: SearchRepo) => {
      setCloningKey(repo.full_name);
      try {
        const targetDir = await resolveDefaultRepoParentPath({
          location: defaultRepoLocation,
          customPath: customDefaultRepoPath,
          ensureDirectory: true,
        });
        if (!targetDir) {
          Message.error(
            t("explore.cloneNoTarget", {
              defaultValue:
                "No default workspace folder configured. Set one in Settings.",
            })
          );
          return;
        }
        const result = await zodActionRegistry.execute("repo.clone", {
          url: repo.clone_url || `https://github.com/${repo.full_name}.git`,
          targetDir,
        });
        if (result.success) {
          Message.success(
            t("explore.cloneSuccess", {
              defaultValue: "Cloned {{name}}",
              name: repo.full_name,
            })
          );
        } else {
          Message.error(
            result.message ||
              t("explore.cloneFailed", { defaultValue: "Clone failed" })
          );
        }
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setCloningKey(null);
      }
    },
    [customDefaultRepoPath, defaultRepoLocation, t]
  );

  const sortLabel = useMemo<Record<RepoSearchSort, string>>(
    () => ({
      best_match: t("explore.sort.bestMatch", { defaultValue: "Best match" }),
      stars: t("explore.sort.stars", { defaultValue: "Stars" }),
      updated: t("explore.sort.updated", { defaultValue: "Recently updated" }),
      forks: t("explore.sort.forks", { defaultValue: "Forks" }),
    }),
    [t]
  );

  const hasResults = Boolean(response && response.items.length > 0);
  const showHero = !hasResults;

  const sortTabs = useMemo(
    () => SORT_VALUES.map((value) => ({ key: value, label: sortLabel[value] })),
    [sortLabel]
  );

  const canSubmit = query.trim().length > 0 && !loading;
  const searchButton = (
    <button
      type="submit"
      disabled={!canSubmit}
      aria-label={t("explore.search", { defaultValue: "Search" })}
      data-state={canSubmit ? "search" : "idle"}
      className={`${INPUT_AREA_BUTTONS.iconButtonSizeClass} flex shrink-0 items-center justify-center rounded-full leading-none transition-colors duration-200 focus:outline-none ${
        canSubmit
          ? INPUT_AREA_BUTTONS.iconButtonActive
          : INPUT_AREA_BUTTONS.iconButtonInactive
      }`}
      style={{ lineHeight: 0 }}
    >
      <HugeiconsIcon
        icon={Search01Icon}
        data-icon="search"
        size={INPUT_AREA_BUTTONS.iconSize}
        strokeWidth={2}
        className="block text-[#fff]"
      />
    </button>
  );

  const heroSection = (
    <div
      className={`flex w-full flex-col items-center gap-4 ${showHero ? "text-center" : ""}`}
    >
      <h1
        className={`${titleSizeClass} font-semibold leading-tight text-text-1`}
      >
        Find a repo and turn it into your next app
      </h1>
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={handleSubmit}
        role="search"
      >
        <Input
          type="search"
          value={query}
          onChange={setQuery}
          placeholder={t("explore.searchPlaceholder", {
            defaultValue:
              "Search GitHub repositories (e.g. language:rust tauri)",
          })}
          suffix={searchButton}
          allowClear
          size="large"
          autoFocus
          className="!h-auto [&_.input-inner]:!h-auto [&_.input-inner]:!rounded-full [&_.input-inner]:!pb-1 [&_.input-inner]:!pl-5 [&_.input-inner]:!pr-2 [&_.input-inner]:!pt-1"
        />
        <div className="flex items-center justify-center">
          <TabPill
            variant="pill"
            appearance="ghost"
            size="default"
            fillWidth={false}
            tabs={sortTabs}
            activeTab={sort}
            onChange={(key) => handleSortChange(key as RepoSearchSort)}
          />
          {loading ? (
            <span className="ml-2 text-[11px] text-text-3">
              {t("explore.searching", { defaultValue: "Searching..." })}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide">
        <div
          className={`flex min-h-full flex-col gap-4 ${showHero ? "py-5" : "pb-5"} ${DETAIL_PANEL_TOKENS.contentWidth}`}
        >
          {showHero ? (
            <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-4">
              {heroSection}

              {error ? (
                <div className="w-full max-w-[640px] text-left">
                  <InlineAlert
                    type="danger"
                    title={t("explore.errorTitle", {
                      defaultValue: "Search failed",
                    })}
                  >
                    {error}
                  </InlineAlert>
                </div>
              ) : null}

              {loading && !response ? (
                <div className="text-[12px] text-text-3">
                  {t("explore.searching", { defaultValue: "Searching..." })}
                </div>
              ) : null}

              {response && !loading && !error ? (
                <div className="flex flex-col items-center gap-1 text-[12px] text-text-3">
                  <span>
                    {t("explore.noResultsTitle", {
                      defaultValue: "No repositories matched",
                    })}
                  </span>
                  <span className="text-[11px]">
                    {t("explore.noResultsSubtitle", {
                      defaultValue: "Try a different query or sort.",
                    })}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="sticky top-0 z-10 -mx-4 bg-chat-pane px-4 pb-3 pt-5">
                {heroSection}
              </div>

              {error ? (
                <InlineAlert
                  type="danger"
                  title={t("explore.errorTitle", {
                    defaultValue: "Search failed",
                  })}
                >
                  {error}
                </InlineAlert>
              ) : null}

              {response ? (
                <div className="flex items-center justify-between text-[11px] text-text-3">
                  <span>
                    {t("explore.resultsCount", {
                      defaultValue: "{{shown}} of {{total}} repositories",
                      shown: response.items.length,
                      total: response.total_count.toLocaleString(),
                    })}
                  </span>
                  {response.incomplete_results ? (
                    <span>
                      {t("explore.partial", {
                        defaultValue: "(partial — search timed out)",
                      })}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col">
                {response!.items.map((repo) => (
                  <SearchRepoCard
                    key={repo.id}
                    repo={repo}
                    onOpen={handleOpen}
                    onClone={handleClone}
                    cloningKey={cloningKey}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorkspaceExplorePanelView;
