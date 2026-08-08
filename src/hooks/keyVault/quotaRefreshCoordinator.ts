type QuotaRefreshRunner = () => Promise<boolean>;

interface QuotaRefreshLane {
  active: Promise<boolean>;
  activeIsForced: boolean;
  queuedForced?: Promise<boolean>;
}

const quotaRefreshLanes = new Map<string, QuotaRefreshLane>();

/**
 * Share one quota-refresh lane across every mounted KeyVault consumer.
 *
 * A manual forced refresh joins an existing forced request. If the active
 * request may use cached data, one forced follow-up is queued instead.
 */
export function runSharedQuotaRefresh(
  accountKey: string,
  force: boolean,
  runner: QuotaRefreshRunner
): Promise<boolean> {
  const existing = quotaRefreshLanes.get(accountKey);
  if (existing) {
    if (!force || existing.activeIsForced) return existing.active;
    if (existing.queuedForced) return existing.queuedForced;

    const queuedForced = existing.active
      .catch(() => false)
      .then(() => {
        existing.active = queuedForced;
        existing.activeIsForced = true;
        return runner();
      })
      .finally(() => {
        if (quotaRefreshLanes.get(accountKey) === existing) {
          quotaRefreshLanes.delete(accountKey);
        }
      });
    existing.queuedForced = queuedForced;
    return queuedForced;
  }

  const request = runner().finally(() => {
    const current = quotaRefreshLanes.get(accountKey);
    if (current?.active === request && !current.queuedForced) {
      quotaRefreshLanes.delete(accountKey);
    }
  });
  quotaRefreshLanes.set(accountKey, {
    active: request,
    activeIsForced: force,
  });
  return request;
}

export const quotaRefreshCoordinatorInternals = {
  clear(): void {
    quotaRefreshLanes.clear();
  },
  size(): number {
    return quotaRefreshLanes.size;
  },
};
