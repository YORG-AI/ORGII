/**
 * useSlashItemsCache
 *
 * Shared hook that fetches and caches the full slash-menu item list:
 * built-in actions + installed skills + connected MCP tools.
 *
 * Both `useSlashCommand` (inline "/" menu) and `PinnedActionsBar` ("..."
 * panel) need identical fetch logic. This hook owns the one canonical copy
 * so any bug fix or feature (e.g. new skill filter) applies everywhere.
 *
 * Design:
 *  - The hook maintains a warm in-memory cache via `itemsCacheRef`.
 *  - `prefetch(query)` shows cached items immediately, then fires a fresh
 *    fetch in the background and updates `filteredItems`.
 *  - `fetchFresh()` refreshes the list (bounded by the shared skills scanner's
 *    TTL + coalescing; pass `{ force: true }` to bypass the TTL). Awaitable.
 *  - Skill scans are lazy: mounting the hook does NOT scan — the backend
 *    `skills_list` fires only on `prefetch`/`fetchFresh`.
 *  - A `cancelledRef` prevents setState after unmount.
 */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import {
  normalizeSkillDescription,
  resolveSkillGroup,
} from "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal/slashItemUtils";
import { createLogger } from "@src/hooks/logger";
import { mergeInstalledSkills } from "@src/hooks/skills/installedSkillsMerge";
import { scanInstalledSkills } from "@src/hooks/skills/installedSkillsScan";
import { installedSkillsAtom } from "@src/store/skills/installedSkillsAtom";
import { type InstalledSkill, type SlashItem } from "@src/types/extensions";

const logger = createLogger("useSlashItemsCache");
const MAX_SLASH_ITEMS_SCOPE_CACHE_SIZE = 12;
const slashItemsCacheByScope = new Map<string, SlashItem[]>();

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getUniqueWorkspacePaths(paths?: string[]): string[] {
  const uniquePaths = new Set<string>();
  for (const path of paths ?? []) {
    const normalizedPath = normalizeWorkspacePath(path);
    if (normalizedPath) uniquePaths.add(normalizedPath);
  }
  return [...uniquePaths];
}

function isWorkspaceSkill(
  skill: InstalledSkill,
  workspacePaths: string[]
): boolean {
  const skillPath = normalizeWorkspacePath(skill.path);
  return workspacePaths.some((workspacePath) => {
    const workspacePrefix = `${workspacePath}/`;
    if (!skillPath.startsWith(workspacePrefix)) return false;
    const relativePath = skillPath.slice(workspacePrefix.length);
    return (
      relativePath.startsWith("skills/") ||
      /^\.[^/]+\/skills\//.test(relativePath)
    );
  });
}

function getSlashItemIdentity(item: SlashItem): string {
  return [
    item.category,
    item.name,
    item.description,
    item.source,
    item.acceptsArgs ? "args" : "no-args",
    item.skillName ?? "",
    item.skillPath ? normalizeWorkspacePath(item.skillPath) : "",
    item.skillScope ?? "",
    item.serverName ?? "",
  ].join("\0");
}

/**
 * Built-in action names are reserved: a user/workspace skill named after a
 * built-in (e.g. a skill called "canvas") would insert the SAME pill
 * serialization the submit-time interceptor claims, so the skill could never
 * run — and the menu would show two identical rows. Prefer the built-in and
 * drop the colliding skill rows (comparison is case-insensitive and covers
 * both the display name and the slash token, since either produces the
 * hijackable serialization).
 */
export function dedupeSkillItemsAgainstBuiltins(
  builtinItems: ReadonlyArray<SlashItem>,
  skillItems: ReadonlyArray<SlashItem>
): SlashItem[] {
  const reservedNames = new Set(
    builtinItems
      .filter((item) => item.category === "action")
      .map((item) => item.name.toLowerCase())
  );
  if (reservedNames.size === 0) return [...skillItems];
  return skillItems.filter(
    (item) =>
      !reservedNames.has(item.name.toLowerCase()) &&
      !reservedNames.has((item.skillName ?? item.name).toLowerCase())
  );
}

/**
 * Cache key for one assembled item list. The module-global cache is shared by
 * every consumer, but different consumers embed different built-in sets
 * (ChatPanel vs PinnedActionsBar vs CLI sessions without canvas) — a key of
 * only the workspace paths would leak one consumer's built-ins into another.
 */
export function buildSlashItemsScopeKey(
  workspacePathsKey: string,
  builtinItems: ReadonlyArray<SlashItem>
): string {
  return [
    workspacePathsKey,
    builtinItems.map(getSlashItemIdentity).join("\u0001"),
  ].join("\u0002");
}

function slashItemsEqual(left: SlashItem[], right: SlashItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      getSlashItemIdentity(item) === getSlashItemIdentity(right[index])
  );
}

function setScopedSlashItemsCache(scopeKey: string, items: SlashItem[]): void {
  if (!slashItemsCacheByScope.has(scopeKey)) {
    while (slashItemsCacheByScope.size >= MAX_SLASH_ITEMS_SCOPE_CACHE_SIZE) {
      const oldestKey = slashItemsCacheByScope.keys().next().value;
      if (oldestKey === undefined) break;
      slashItemsCacheByScope.delete(oldestKey);
    }
  }
  slashItemsCacheByScope.set(scopeKey, items);
}

export interface UseSlashItemsCacheOptions {
  /**
   * Extra built-in SlashItems to prepend before skills + tools.
   * Each consumer passes a different subset of SLASH_ACTIONS.
   */
  builtinItems: SlashItem[];
  /** Repo/workspace scopes whose root `skills/` or hidden `.tool/skills/` roots should appear. */
  workspacePaths?: string[];
}

export interface UseSlashItemsCacheReturn {
  /** Current full item list for the active workspace scope. Renderers apply query filtering. */
  filteredItems: SlashItem[];
  /** True while a backend fetch is in flight. */
  loading: boolean;
  /**
   * Show cached items for `query` immediately, then kick off a fresh
   * backend fetch and update `filteredItems` when it resolves.
   */
  prefetch: (query: string) => void;
  /**
   * Fetch the full item list and update it when it changed. Bounded by the
   * shared scanner's TTL + in-flight coalescing; pass `{ force: true }` to
   * bypass the TTL (e.g. an explicit "…" panel open).
   */
  fetchFresh: (options?: { force?: boolean }) => Promise<SlashItem[]>;
}

export function useSlashItemsCache(
  options: UseSlashItemsCacheOptions
): UseSlashItemsCacheReturn {
  const { builtinItems, workspacePaths } = options;
  const setInstalledSkills = useSetAtom(installedSkillsAtom);
  const workspacePathsKey = getUniqueWorkspacePaths(workspacePaths).join("\0");
  // Consumers embed different built-in sets — discriminate the shared cache
  // by both axes so one consumer's assembled list never leaks into another's.
  const scopeKey = buildSlashItemsScopeKey(workspacePathsKey, builtinItems);

  const [filteredItems, setFilteredItems] = useState<SlashItem[]>([]);
  const [loading, setLoading] = useState(false);

  const itemsCacheRef = useRef<SlashItem[]>(
    slashItemsCacheByScope.get(scopeKey) ?? []
  );
  const fetchSeqRef = useRef(0);
  const cancelledRef = useRef(false);
  // Keep a stable ref to builtinItems so fetch doesn't need it in deps
  const builtinItemsRef = useRef(builtinItems);
  builtinItemsRef.current = builtinItems;

  const doFetch = useCallback(
    async (force = false): Promise<SlashItem[]> => {
      setLoading(true);
      try {
        const scopePaths = workspacePathsKey
          ? workspacePathsKey.split("\0")
          : [];
        // Skills are scanned through the bounded shared scanner (coalesces
        // concurrent callers, reuses a recent result within the TTL) so opening
        // the menu/panel repeatedly can never hammer the backend `skills_list`.
        const [rawSkills, mcpServers] = await Promise.all([
          scanInstalledSkills(scopePaths, { force }),
          rpc.mcp.listServers({}).catch((err) => {
            logger.warn("Failed to list MCP servers for slash menu:", err);
            return [];
          }),
        ]);

        const workspaceSkillRoots = scopePaths.map(normalizeWorkspacePath);
        logger.rateLimited("slash-skills-scan", 5_000, "slash skills fetched", {
          workspacePaths: workspaceSkillRoots,
          skillCount: rawSkills.length,
          workspaceSkillCount: rawSkills.filter((skill) =>
            isWorkspaceSkill(skill, workspaceSkillRoots)
          ).length,
          skillPaths: rawSkills.map((skill) => skill.path),
        });

        if (rawSkills.length > 0) {
          setInstalledSkills((current) =>
            mergeInstalledSkills([current, rawSkills])
          );
        }

        const skillItems: SlashItem[] = dedupeSkillItemsAgainstBuiltins(
          builtinItemsRef.current,
          rawSkills
            .filter((s) => s.enabled)
            .map((s) => ({
              name: s.name,
              skillName: s.name,
              skillPath: s.path,
              description: normalizeSkillDescription(s),
              category: "skill" as const,
              source: resolveSkillGroup(s),
              acceptsArgs: false,
              skillScope: isWorkspaceSkill(s, workspaceSkillRoots)
                ? "workspace"
                : "user",
            }))
        );

        const connectedServers = mcpServers.filter(
          (srv) => srv.status === "connected" && !srv.disabled
        );

        const toolItems: SlashItem[] = (
          await Promise.all(
            connectedServers.map((srv) =>
              rpc.mcp.listServerTools({ serverName: srv.name }).then(
                (tools) =>
                  tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    category: "tool" as const,
                    source: srv.name,
                    acceptsArgs: true,
                    serverName: srv.name,
                  })),
                (err) => {
                  logger.warn(
                    `Failed to list tools for MCP server "${srv.name}":`,
                    err
                  );
                  return [] as SlashItem[];
                }
              )
            )
          )
        ).flat();

        const assembled: SlashItem[] = [
          ...builtinItemsRef.current,
          ...skillItems,
          ...toolItems,
        ];

        setScopedSlashItemsCache(scopeKey, assembled);
        if (!cancelledRef.current) {
          itemsCacheRef.current = assembled;
        }
        return assembled;
      } finally {
        if (!cancelledRef.current) {
          setLoading(false);
        }
      }
    },
    [setInstalledSkills, workspacePathsKey, scopeKey]
  );

  const prefetch = useCallback(
    (_query: string) => {
      const currentFetchSeq = fetchSeqRef.current + 1;
      fetchSeqRef.current = currentFetchSeq;
      const cachedItems = slashItemsCacheByScope.get(scopeKey) ?? [];
      if (cachedItems.length > 0) {
        itemsCacheRef.current = cachedItems;
        setFilteredItems(cachedItems);
      }
      doFetch().then((items) => {
        if (cancelledRef.current || fetchSeqRef.current !== currentFetchSeq) {
          return;
        }
        if (cachedItems.length === 0 || !slashItemsEqual(cachedItems, items)) {
          setFilteredItems(items);
        }
      });
    },
    [doFetch, scopeKey]
  );

  const fetchFresh = useCallback(
    async (options?: { force?: boolean }): Promise<SlashItem[]> => {
      const currentItems = itemsCacheRef.current;
      const items = await doFetch(options?.force ?? false);
      if (!cancelledRef.current && !slashItemsEqual(currentItems, items)) {
        setFilteredItems(items);
      }
      return items;
    },
    [doFetch]
  );

  // Lazy warm-up: when the active repo/workspace scope changes, only paint the
  // cached items for that scope (instant, no IPC). The actual backend scan is
  // deferred until the user opens the "/" menu (`prefetch`) or the "…" panel
  // (`fetchFresh`), or a pinned skill needs resolving — so simply mounting the
  // chat input no longer triggers a `skills_list` scan.
  useEffect(() => {
    cancelledRef.current = false;
    const cachedItems = slashItemsCacheByScope.get(scopeKey) ?? [];
    if (cachedItems.length > 0) {
      itemsCacheRef.current = cachedItems;
      setFilteredItems(cachedItems);
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [scopeKey]);

  return { filteredItems, loading, prefetch, fetchFresh };
}
