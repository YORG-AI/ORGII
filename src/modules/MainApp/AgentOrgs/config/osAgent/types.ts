/**
 * OS Agent Page Types
 *
 * Shared interfaces for the OS Agent settings subpage.
 */

// ============================================
// Gateway Status
// ============================================

export interface ChannelStatusEntry {
  name: string;
  connected: boolean;
  error: string | null;
}

interface AutomationStatusInfo {
  running: boolean;
  activeRules: number;
  totalRules: number;
  totalFires: number;
  uptimeSecs: number;
  agentAlive: boolean;
  messagesProcessed: number;
  lastHealthCheck: string;
}

export interface GatewayStatusInfo {
  running: boolean;
  channels: ChannelStatusEntry[];
  automation: AutomationStatusInfo;
}

// ============================================
// Credential Status
// ============================================

export interface CredentialStatus {
  found: boolean;
  provider: string | null;
  error?: string;
}
