/**
 * Resolving a `workitem://` reference posted in a channel.
 *
 * The pill carries identity only (`<projectSlug>/<shortId>`), so the card has
 * to read the item to show anything beyond the title snapshot. That read goes
 * through `projectApi` — the same path `useTeamInboxNavigation` takes to open
 * a Work Item — rather than any channel-local copy, so a card can never
 * disagree with the Work Item panel it opens.
 *
 * Caching mirrors `useSessionTurnOverview`, the precedent the session card
 * already relies on: a module-level map plus in-flight coalescing, both keyed
 * by `<orgId>/<projectSlug>/<shortId>`. A transcript that names one item ten times
 * does ONE read, and a card remounting inside the virtualized list is free.
 * The cache is intentionally not invalidated on write — a reference card is a
 * cheap summary of an item the reader opens to see live, and a channel with a
 * long backlog should not re-read every referenced item on every scroll.
 *
 * `readProject` is loaded alongside because opening the item needs the
 * project's id, name and org — `openWorkItemInChatPanelTabAtom` takes the
 * whole `ChatPanelSelectedWorkItem` payload, not just a slug. It is loaded
 * with `allSettled`: a missing project makes the card degraded-but-openable,
 * not unresolvable, which is exactly how `useTeamInboxNavigation` treats it.
 */
import { useEffect, useState } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import type { WorkItem } from "@src/types/core/workItem";

const log = createLogger("ChannelWorkItemCard");

const MAX_WORK_ITEM_CACHE_SIZE = 200;

export interface ChannelWorkItemTarget {
  orgId?: string;
  projectSlug: string;
  shortId: string;
}

export interface ResolvedChannelWorkItem {
  workItem: WorkItem;
  /** Empty when the project row could not be read; the item still opens. */
  projectId: string;
  projectName: string;
  orgId: string | undefined;
}

const workItemCache = new Map<string, ResolvedChannelWorkItem>();
const inFlightLoads = new Map<
  string,
  Promise<ResolvedChannelWorkItem | null>
>();

export function channelWorkItemCacheKey(target: ChannelWorkItemTarget): string {
  return `${target.orgId ?? "default"}/${target.projectSlug}/${target.shortId}`;
}

function remember(key: string, resolved: ResolvedChannelWorkItem): void {
  if (workItemCache.size >= MAX_WORK_ITEM_CACHE_SIZE) {
    const oldestKey = workItemCache.keys().next().value;
    if (oldestKey) workItemCache.delete(oldestKey);
  }
  workItemCache.set(key, resolved);
}

/**
 * Session rails may point directly at a standalone bootstrap item and carry
 * no project slug. Channel pills do carry a slug, but the item behind one may
 * still live in the standalone bucket — a reference posted before the item
 * moved, or an `@`-picked item that never had a project. A missing slug reads
 * standalone immediately; a failed project read falls back there.
 */
async function readWorkItemData(target: ChannelWorkItemTarget) {
  const scope = target.orgId ? { orgId: target.orgId } : undefined;
  if (!target.projectSlug) {
    return projectApi.readStandaloneWorkItem(target.shortId, scope);
  }
  try {
    return await projectApi.readWorkItem(target.projectSlug, target.shortId);
  } catch (error: unknown) {
    log.debug("project work item read failed, trying standalone", error);
    return projectApi.readStandaloneWorkItem(target.shortId, scope);
  }
}

async function loadChannelWorkItem(
  target: ChannelWorkItemTarget
): Promise<ResolvedChannelWorkItem> {
  const [workItemResult, projectResult] = await Promise.allSettled([
    readWorkItemData(target),
    target.projectSlug
      ? projectApi.readProject(target.projectSlug)
      : Promise.resolve(null),
  ]);

  if (workItemResult.status === "rejected") {
    throw workItemResult.reason;
  }
  const project =
    projectResult.status === "fulfilled" ? projectResult.value : null;

  return {
    workItem: enrichedWorkItemToUI(
      standaloneWorkItemDataToEnriched(workItemResult.value)
    ),
    projectId: project?.meta.id ?? "",
    projectName:
      project?.meta.name ?? (target.projectSlug || "Standalone Work Items"),
    orgId: project?.meta.org_id ?? target.orgId,
  };
}

function loadCoalesced(
  key: string,
  target: ChannelWorkItemTarget
): Promise<ResolvedChannelWorkItem | null> {
  const cached = workItemCache.get(key);
  if (cached) return Promise.resolve(cached);

  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight;

  const work = loadChannelWorkItem(target)
    .then((resolved) => {
      remember(key, resolved);
      return resolved;
    })
    .finally(() => {
      inFlightLoads.delete(key);
    });
  inFlightLoads.set(key, work);
  return work;
}

interface ChannelWorkItemState {
  key: string;
  resolved: ResolvedChannelWorkItem | null;
  /** False until the first load settles, so the card can hold its snapshot. */
  settled: boolean;
}

/**
 * `null` with `settled: false` means "still reading"; `null` with
 * `settled: true` means "there is nothing here", which is what turns the card
 * degraded.
 */
export function useChannelWorkItem(target: ChannelWorkItemTarget): {
  resolved: ResolvedChannelWorkItem | null;
  settled: boolean;
} {
  const key = channelWorkItemCacheKey(target);
  const [state, setState] = useState<ChannelWorkItemState>(() => {
    const cached = workItemCache.get(key) ?? null;
    return { key, resolved: cached, settled: cached !== null };
  });

  const { orgId, projectSlug, shortId } = target;

  useEffect(() => {
    let cancelled = false;

    void loadCoalesced(key, { orgId, projectSlug, shortId })
      .then((resolved) => {
        if (cancelled) return;
        setState({ key, resolved, settled: true });
      })
      .catch((error: unknown) => {
        // A reference outlives the item it names: a project this machine has
        // never synced, an item deleted since. Cards degrade; an unhandled
        // rejection would surface app-wide on a transcript full of them.
        log.debug("channel work item load failed:", key, error);
        if (cancelled) return;
        setState({ key, resolved: null, settled: true });
      });

    return () => {
      cancelled = true;
    };
  }, [key, orgId, projectSlug, shortId]);

  if (state.key === key) return state;
  const cached = workItemCache.get(key) ?? null;
  return { resolved: cached, settled: cached !== null };
}
