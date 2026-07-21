import { updateShellProcessAtom } from "@src/store/session/shellProcessAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { invokeTauri } from "@src/util/platform/tauri/init";

export interface KillAgentShellProcessOptions {
  pid: number;
  sessionId?: string;
  callId?: string;
}

export async function killAgentShellProcess({
  pid,
  sessionId,
  callId,
}: KillAgentShellProcessOptions): Promise<string> {
  const result = await invokeTauri<string>("agent_kill_shell_process", { pid });
  const alreadyExited =
    typeof result === "string" && result.includes("already exited");
  if (sessionId && callId) {
    getInstrumentedStore().set(updateShellProcessAtom, {
      type: "exit",
      sessionId,
      pid,
      callId,
      killed: !alreadyExited,
    });
  }

  return result;
}
