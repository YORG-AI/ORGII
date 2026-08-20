/**
 * Output channel types shared across the workstation domain.
 *
 * Canonical home for OutputChannel, OutputChannelType, OutputLine,
 * OutputPanelConfig, and the output-integration hook contracts
 * (UseOutputChannelsReturn, UseTaskOutputIntegrationReturn). Lives here so
 * src/store/, src/services/, and the CodeEditor hooks that implement the
 * contracts can share them without importing each other.
 */

export type OutputChannelType =
  | "tasks"
  | "git"
  | "build"
  | "filesync"
  | "test"
  | "extension"
  | "lsp"
  | "gui-agent"
  | "custom";

export interface OutputLine {
  id: string;
  content: string;
  timestamp: number;
  type?: "normal" | "error" | "warning" | "info" | "success";
}

export interface OutputChannel {
  id: string;
  name: string;
  type: OutputChannelType;
  content: string;
  maxChars?: number;
  active?: boolean;
  processAnsi?: boolean;
}

export interface OutputPanelConfig {
  defaultMaxLines?: number;
  autoScroll?: boolean;
  showTimestamps?: boolean;
  wordWrap?: boolean;
}

// ============================================
// Output-integration hook contracts
// ============================================

/** Contract implemented by `useOutputChannels` (CodeEditor/hooks/output). */
export interface UseOutputChannelsReturn {
  /** All output channels */
  channels: OutputChannel[];
  /** Currently active channel ID */
  activeChannelId: string | null;
  /** Get channel by ID */
  getChannel: (channelId: string) => OutputChannel | undefined;
  /** Create a new channel */
  createChannel: (
    name: string,
    type: OutputChannelType,
    maxChars?: number
  ) => string;
  /** Delete a channel */
  deleteChannel: (channelId: string) => void;
  /** Append text to a channel */
  appendToChannel: (channelId: string, text: string) => void;
  /** Clear a channel */
  clearChannel: (channelId: string) => void;
  /** Clear all channels */
  clearAllChannels: () => void;
  /** Set active channel */
  setActiveChannel: (channelId: string) => void;
  /** Set channel active status */
  setChannelActive: (channelId: string, active: boolean) => void;
}

/** Contract implemented by `useTaskOutputIntegration` (CodeEditor/hooks/output). */
export interface UseTaskOutputIntegrationReturn {
  /** Run a task with output streaming */
  runTaskWithOutput: (params: {
    taskId: string;
    command: string;
    shell?: string;
  }) => Promise<() => void>;
  /** Run an npm script with output streaming */
  runNpmScriptWithOutput: (params: {
    taskId: string;
    script: string;
  }) => Promise<() => void>;
}
