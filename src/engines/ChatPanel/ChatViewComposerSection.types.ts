import type React from "react";

import type { ScrollNavState } from "./ChatHistory";
import type { InlineSection } from "./InputArea/components/CollapsedInlineRow";
import type { FileChangesResult } from "./InputArea/components/compactFileChangesHelpers";
import type { QueueEditInputAreaProps } from "./InputArea/hooks/useQueueEditMode";
import type {
  CustomMentionOption,
  SubmitOverrideInput,
} from "./hooks/useInputArea/types";

interface StreamRetryInfo {
  kind: string;
  attempt: number;
  maxAttempts: number;
}

interface AgentOrgInterventionView {
  intervention:
    | import("@src/api/tauri/agent").AgentOrgMemberIntervention
    | null;
  memberName?: string | null;
  error: string | null;
  returning: boolean;
  onReturnToWork: () => Promise<boolean>;
}

interface GroupChatPendingMessageView {
  targetMemberName: string;
}

export interface ChatViewComposerSectionProps {
  sessionId: string;
  inputAreaSessionId: string;
  showMainComposer: boolean;
  composerRef: React.Ref<HTMLDivElement>;
  inputBoxRef?: React.Ref<HTMLDivElement>;
  chatPanelPosition: "left" | "right";
  planCollapsed: boolean;
  onPlanCollapse: () => void;
  questionCollapsed: boolean;
  permissionCollapsed: boolean;
  modeSwitchCollapsed: boolean;
  onQuestionCollapse: () => void;
  onPermissionCollapse: () => void;
  onModeSwitchCollapse: () => void;
  onQuestionDataChange: (hasData: boolean) => void;
  onPermissionDataChange: (hasData: boolean) => void;
  onModeSwitchDataChange: (hasData: boolean) => void;
  queueExpanded: boolean;
  processExpanded: boolean;
  queuedMessages: import("@src/store/ui/messageQueueAtom").QueuedMessage[];
  onCancelQueuedMessage: (messageId: string) => void;
  onSendQueuedMessageNow: (messageId: string) => void;
  onReorderQueuedMessages: (fromIndex: number, toIndex: number) => void;
  onToggleQueue: () => void;
  onToggleProcess: () => void;
  onProcessVisibleCountChange: (count: number) => void;
  onFilesExpand: () => void;
  filesMenu?: React.ReactNode;
  initialFileChanges?: FileChangesResult;
  groupChatPendingMessage: GroupChatPendingMessageView | null;
  groupChatViewActive: boolean;
  hasAnyInlineSection: boolean;
  scrollNav: ScrollNavState | null;
  inlineSections: InlineSection[];
  hasModeSwitch: boolean;
  agentOrgIntervention: AgentOrgInterventionView | null;
  streamRetry: StreamRetryInfo | null;
  groupChatPausedBottomContent: React.ReactNode;
  onSubmitOverride: (input: SubmitOverrideInput) => Promise<boolean>;
  customMentionOptions: ReadonlyArray<CustomMentionOption>;
  queueEditProps: QueueEditInputAreaProps;
  disableStopWhenEmpty?: boolean;
}
