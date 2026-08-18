import { useAtomValue } from "jotai";

import { identitySnapshotAtom } from "./identitySnapshotAtom";
import { getActiveIdentitySession } from "./identityTypes";
import type {
  IdentityRealm,
  IdentitySession,
  IdentitySnapshot,
} from "./identityTypes";

export function useIdentitySnapshot(): IdentitySnapshot {
  return useAtomValue(identitySnapshotAtom);
}

export function useActiveIdentitySession(
  realm: IdentityRealm
): IdentitySession | null {
  return getActiveIdentitySession(useIdentitySnapshot(), realm);
}
