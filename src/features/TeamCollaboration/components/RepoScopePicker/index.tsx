/**
 * RepoScopePicker — git-remote-based repo scope selection (design §8.3).
 *
 * Replaces the free-text "absolute repo path" inputs everywhere an org repo
 * scope is chosen (org creation, admin scope editing, member join requests).
 * Lists the workspace repos from `useSharedRepoList` (the same source the
 * Spotlight RepoSelector uses) and selects by SHAREABLE SCOPE KEY — the
 * normalized git remote URL — never by local path:
 *
 * - a repo with `repo_url` resolves synchronously via normalizeRepoScopeKey;
 * - a local-only entry resolves through `resolveShareableScopeKey`
 *   (git-remotes IPC, cached module-wide, shared with the sync engine);
 * - a repo with NO git remote is rendered disabled with a hint — it has no
 *   cross-machine identity, so it cannot be shared (git-remote-only rule).
 *
 * Selection is keyed by scope key (not repo id): two checkouts of the same
 * remote toggle together, and the emitted keys are deduped by construction.
 */
import React, { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon, Tick01Icon } from "@src/icons";
import useSharedRepoList from "@src/scaffold/GlobalSpotlight/hooks/data/useSharedRepoList";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";

import { normalizeRepoScopeKey } from "../../collabSyncUtils";
import {
  getShareableScopeKeyVersion,
  peekShareableScopeKey,
  primeShareableScopeKey,
  subscribeShareableScopeKeys,
} from "../../repoScopeResolver";

interface RepoScopePickerProps {
  /** Currently selected scope keys (normalized remote keys). */
  selectedKeys: string[];
  /** Called with the next full selection (deduped scope keys). */
  onChange: (keys: string[]) => void;
  /** Multi-select (org scopes) vs single-select (join request). */
  multiple?: boolean;
  /** Keep selected repos visible but disabled so this surface only adds. */
  addOnly?: boolean;
  disabled?: boolean;
}

/**
 * `undefined` = still resolving (row shown busy/disabled),
 * `null` = no git remote (row disabled with hint),
 * string = shareable scope key.
 */
function getRepoScopeKey(repo: RepoItem): string | null | undefined {
  if (repo.repo_url) return normalizeRepoScopeKey(repo.repo_url) || null;
  if (!repo.fs_uri) return null;
  return peekShareableScopeKey(repo.fs_uri);
}

export function RepoScopePicker({
  selectedKeys,
  onChange,
  multiple = true,
  addOnly = false,
  disabled = false,
}: RepoScopePickerProps) {
  const { t } = useTranslation("navigation");
  const { repos, repoLoading, loadRepos } = useSharedRepoList("");
  // Re-render when an async remote resolution lands in the shared cache.
  useSyncExternalStore(
    subscribeShareableScopeKeys,
    getShareableScopeKeyVersion
  );

  useEffect(() => {
    // queueMicrotask: loadRepos flips the repo-loading atom synchronously,
    // which the set-state-in-effect lint (correctly) rejects inline.
    queueMicrotask(() => void loadRepos());
  }, [loadRepos]);

  useEffect(() => {
    // Kick remote resolution for local-only entries; results arrive via the
    // cache subscription above.
    for (const repo of repos) {
      if (!repo.repo_url && repo.fs_uri) primeShareableScopeKey(repo.fs_uri);
    }
  }, [repos]);

  const normalizedSelection = useMemo(
    () => new Set(selectedKeys.map((key) => normalizeRepoScopeKey(key))),
    [selectedKeys]
  );

  const handleToggle = (key: string) => {
    if (disabled) return;
    const normalized = normalizeRepoScopeKey(key);
    const isSelected = normalizedSelection.has(normalized);
    if (addOnly && isSelected) return;
    if (!multiple) {
      onChange(isSelected ? [] : [normalized]);
      return;
    }
    onChange(
      isSelected
        ? selectedKeys.filter(
            (selected) => normalizeRepoScopeKey(selected) !== normalized
          )
        : [...selectedKeys, normalized]
    );
  };

  return (
    <div
      className="flex max-h-56 w-full flex-col divide-y divide-border-2 overflow-y-auto rounded-xl border border-border-2 bg-bg-2"
      data-testid="repo-scope-picker"
    >
      {repos.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-text-3">
          {repoLoading
            ? t("collaboration.repoPicker.loading")
            : t("collaboration.repoPicker.empty")}
        </div>
      ) : (
        repos.map((repo) => {
          const scopeKey = getRepoScopeKey(repo);
          const isSelected =
            typeof scopeKey === "string" &&
            normalizedSelection.has(normalizeRepoScopeKey(scopeKey));
          const selectable =
            typeof scopeKey === "string" &&
            !disabled &&
            !(addOnly && isSelected);
          const scopeLabel =
            scopeKey === undefined
              ? t("collaboration.repoPicker.resolving")
              : (scopeKey ?? t("collaboration.repoPicker.noRemote"));
          return (
            <button
              key={repo.id}
              type="button"
              disabled={!selectable}
              onClick={() => {
                if (typeof scopeKey === "string") handleToggle(scopeKey);
              }}
              className={`flex items-center justify-between gap-3 px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none focus-visible:ring-inset ${
                selectable
                  ? "cursor-pointer hover:bg-fill-2"
                  : "cursor-not-allowed opacity-60"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="min-w-0 truncate text-[12px] text-text-1">
                  {repo.name}
                </span>
                <span className="shrink-0 text-[11px] text-text-3">·</span>
                <span
                  className="min-w-0 flex-1 truncate text-[11px] text-text-3"
                  title={scopeKey ?? repo.fs_uri}
                >
                  {scopeLabel}
                </span>
              </div>
              {isSelected ? (
                <HugeiconsIcon
                  icon={Tick01Icon}
                  data-icon="check"
                  size={14}
                  className="shrink-0 text-primary-6"
                />
              ) : null}
            </button>
          );
        })
      )}
    </div>
  );
}

export default RepoScopePicker;
