/**
 * Shared project scope helpers — the `orgId` filter every slug-keyed read
 * threads through to the cache key and the invoke payload.
 */
export interface ProjectScopeOptions {
  orgId?: string | null;
}

export type WorkItemReadBucket = "active" | "completed";

export interface WorkItemsReadOptions extends ProjectScopeOptions {
  readBucket?: WorkItemReadBucket;
}

export function scopeCacheSegment(options?: ProjectScopeOptions): string {
  return options?.orgId ? `org:${options.orgId}` : "all";
}

export function scopeInvokePayload(options?: ProjectScopeOptions): {
  orgId: string | null;
} {
  return { orgId: options?.orgId ?? null };
}
