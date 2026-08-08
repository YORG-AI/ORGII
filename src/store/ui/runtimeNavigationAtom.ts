import { atom } from "jotai";

export type RuntimeOrganizationView = "today" | "members" | "sync";

/**
 * One-shot navigation request for opening Runtime at a specific organization
 * surface. The Runtime panel consumes and clears it after the requested cloud
 * organization is available, so reopening Runtime later preserves the user's
 * own selection instead of replaying an old guide action.
 */
export interface RuntimeNavigationIntent {
  requestId: number;
  orgId: string;
  view: RuntimeOrganizationView;
}

export const runtimeNavigationIntentAtom = atom<RuntimeNavigationIntent | null>(
  null
);
runtimeNavigationIntentAtom.debugLabel = "runtimeNavigationIntentAtom";
