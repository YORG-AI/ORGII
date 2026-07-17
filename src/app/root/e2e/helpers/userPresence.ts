import { invoke } from "@tauri-apps/api/core";

import {
  userPresenceAtom,
  userPresenceWireAtom,
} from "@src/store/user/userPresenceAtom";
import { userCustomRolesAtom } from "@src/store/user/userRolesAtom";
import type {
  CustomRoleDefinition,
  UserPresenceState,
  UserPresenceWire,
} from "@src/types/userPresence";

import { asError } from "../result";
import type { E2EStore, Result } from "../types";

export function createUserPresenceHelpers({ store }: { store: E2EStore }) {
  const seedUserPresence = async (opts: {
    roles: CustomRoleDefinition[];
    presence: UserPresenceState;
  }): Promise<
    Result<{
      roleCount: number;
      mode: string;
      wire: UserPresenceWire | undefined;
    }>
  > => {
    try {
      store.set(userCustomRolesAtom, opts.roles);
      store.set(userPresenceAtom, opts.presence);
      const wire = store.get(userPresenceWireAtom);
      // The production hook performs this same IPC from a React effect. E2E
      // callers need an awaitable boundary so a just-updated policy cannot
      // race the backend watcher that the next test action creates.
      if (wire) {
        await invoke("set_user_presence", { presence: wire });
      }
      return {
        ok: true,
        roleCount: opts.roles.length,
        mode: opts.presence.mode,
        wire,
      };
    } catch (error) {
      return asError(error);
    }
  };

  return { seedUserPresence };
}
