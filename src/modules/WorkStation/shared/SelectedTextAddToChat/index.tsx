/**
 * Shared owner for DOM text-selection → "Add to Chat" behavior.
 *
 * The wrapped surface owns only its rendered content. This component owns the
 * selection listener, dropdown lifecycle, and addToAgent write boundary.
 */
import { useSetAtom } from "jotai";
import React, { memo, useCallback, useRef } from "react";

import {
  TextSelectionDropdown,
  useTextSelectionDropdown,
} from "@src/scaffold/ContextMenu/exports";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";

interface SelectionControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  displayName: string;
}

const SelectionController: React.FC<SelectionControllerProps> = memo(
  ({ containerRef, displayName }) => {
    const setAddToAgent = useSetAtom(addToAgentAtom);
    const { visible, position, selectedText, hideDropdown } =
      useTextSelectionDropdown({ containerRef });

    const handleAddToChat = useCallback(
      (text: string, _sessionId: string | null) => {
        setAddToAgent({
          type: "terminal",
          text,
          displayName,
        });
      },
      [displayName, setAddToAgent]
    );

    return (
      <TextSelectionDropdown
        visible={visible}
        position={position}
        selectedText={selectedText}
        source="terminal"
        onClose={hideDropdown}
        onAddToContext={handleAddToChat}
      />
    );
  }
);

SelectionController.displayName = "SelectedTextAddToChatController";

export interface SelectedTextAddToChatProps {
  children?: React.ReactNode;
  displayName: string;
  enabled?: boolean;
  /** Remounts only the selection controller when the rendered scope changes. */
  scopeKey?: string | number;
  className?: string;
}

export const SelectedTextAddToChat: React.FC<SelectedTextAddToChatProps> = memo(
  ({ children, displayName, enabled = true, scopeKey, className }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    return (
      <>
        <div ref={containerRef} className={className}>
          {children}
        </div>
        {enabled ? (
          <SelectionController
            key={scopeKey ?? "default"}
            containerRef={containerRef}
            displayName={displayName}
          />
        ) : null}
      </>
    );
  }
);

SelectedTextAddToChat.displayName = "SelectedTextAddToChat";

export default SelectedTextAddToChat;
