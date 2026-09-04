import { Edit04Icon, type IconSvgElement, Wrench01Icon } from "@src/icons";

export interface AgentMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_input: string | null;
  tool_output: string | null;
  model: string | null;
  sequence: number;
  created_at: string;
}

export const STATUS_I18N_KEYS: Record<string, string> = {
  running: "workItems.agentWorkflow.statusRunning",
  completed: "workItems.agentWorkflow.statusCompleted",
  failed: "workItems.agentWorkflow.statusFailed",
  error: "workItems.agentWorkflow.statusFailed",
  cancelled: "workItems.agentWorkflow.statusCancelled",
};

export const TOOL_ICONS: Record<string, IconSvgElement> = {
  edit_file: Edit04Icon,
  apply_patch: Wrench01Icon,
};
