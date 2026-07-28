import { rpc } from "@src/api/tauri/rpc";
import type { HumanSession } from "@src/api/tauri/rpc/schemas/humanSession";

export type {
  HumanSession,
  HumanSessionEntry,
} from "@src/api/tauri/rpc/schemas/humanSession";

export function createHumanSession(request: {
  body: string;
  title?: string;
  workspacePath?: string | null;
}): Promise<HumanSession> {
  return rpc.humanSession.create({ request });
}

export function getHumanSession(sessionId: string): Promise<HumanSession> {
  return rpc.humanSession.get({ sessionId });
}

export function appendHumanSessionEntry(
  sessionId: string,
  body: string
): Promise<HumanSession> {
  return rpc.humanSession.append({ request: { sessionId, body } });
}

export function deleteHumanSession(sessionId: string): Promise<void> {
  return rpc.humanSession.delete({ sessionId });
}
