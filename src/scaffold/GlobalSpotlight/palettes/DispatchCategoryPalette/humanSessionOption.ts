import { SESSION_TARGET_KIND } from "@src/store/session/creatorStateAtom";

import type { AgentOption } from "./types";

export function createHumanSessionOption(name: string): AgentOption {
  return {
    id: "human-session",
    name,
    desc: "",
    iconId: "clipboard-list",
    category: "human_session",
    targetKind: SESSION_TARGET_KIND.HUMAN,
    isBuiltIn: true,
    isCli: false,
    isOrg: false,
  };
}
