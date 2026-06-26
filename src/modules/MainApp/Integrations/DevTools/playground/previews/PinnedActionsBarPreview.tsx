/**
 * PinnedActionsBarPreview
 *
 * Standalone playground preview for PinnedActionsBar. Renders the bar inside
 * a ChatProvider with a mock tiptap ref so all interactions (open picker,
 * manage panel) work without a real chat session.
 */
import { useRef } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import PinnedActionsBar from "@src/engines/ChatPanel/InputArea/components/PinnedActionsBar";

const NOOP = () => {};
const NOOP_STR = () => "";
const NOOP_ARR = () => [];
const NOOP_NULL = () => null;
const NOOP_BOOL = () => false;
const NOOP_MAP = () => ({});
const NOOP_SNAPSHOT = () => ({ parts: [] as never[] });

function PinnedActionsBarPreviewInner() {
  const mockComposerInputRef = useRef<ComposerInputRef>({
    getText: NOOP_STR,
    getTextWithPills: NOOP_STR,
    getTerminalPillTexts: NOOP_MAP,
    getHTML: NOOP_STR,
    getSnapshot: NOOP_SNAPSHOT,
    setContent: NOOP,
    clear: NOOP,
    focus: NOOP,
    isEmpty: NOOP_BOOL,
    insertMentionText: NOOP,
    insertFilePill: NOOP,
    prependFilePill: NOOP,
    appendFilePill: NOOP,
    insertFileReference: NOOP,
    removeFilePill: NOOP,
    getFilePills: NOOP_ARR,
    getEditor: NOOP_NULL,
    triggerAtMention: NOOP,
    triggerSlashContext: NOOP,
    consumeSlashQuery: NOOP,
    placeCaretAtPoint: NOOP_BOOL,
    isInlineMenuActive: NOOP_BOOL,
    insertPrPill: NOOP,
  });

  return (
    <div className="tool-event-preview-shell tool-event-preview-shell--chat">
      <div className="tool-event-preview-shell__content tool-event-preview-shell__content--chat">
        <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-text-3">
          PinnedActionsBar preview — click pills to test interactions
        </div>

        {/* Mirror the real chat input wrapper layout */}
        <div className="flex w-full flex-shrink-0 flex-col items-center px-2 py-2">
          <div className="flex w-full max-w-[800px] flex-col gap-1.5">
            <div className="rounded-[12px] border border-solid border-border-2 bg-chat-input px-1.5 pb-1.5 pt-2.5">
              <PinnedActionsBar composerInputRef={mockComposerInputRef} />
              <div className="flex h-8 items-center px-2 text-[13px] text-text-3 opacity-40">
                Input area (mocked)
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PinnedActionsBarPreview() {
  return (
    <ChatProvider>
      <PinnedActionsBarPreviewInner />
    </ChatProvider>
  );
}
