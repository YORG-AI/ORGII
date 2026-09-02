import type { ReactNode, RefObject } from "react";
import { useCallback, useRef } from "react";

import ComposerSurface from "@src/components/ComposerSurface";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";
import { PropertyDropdownDirectionProvider } from "@src/components/PropertyField/PropertyDropdownDirection";
import { COMPOSER_HORIZONTAL_GUTTER_CLASS } from "@src/config/composerStackTokens";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

export interface CreateComposerTitleInputProps {
  /**
   * Focus the title on mount. The docked composer leaves this off: its main
   * content field takes the focus, matching the agent composer it swaps with.
   */
  autoFocus?: boolean;
  dataTestId: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}

/** Title field shared by Project and Work Item create composers. */
export function CreateComposerTitleInput({
  autoFocus = false,
  dataTestId,
  onChange,
  placeholder,
  value,
}: CreateComposerTitleInputProps) {
  return (
    <Input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      autoFocus={autoFocus}
      appearance="ghost"
      size="small"
      className="flex-1 focus-within:bg-transparent! hover:bg-transparent!"
      inputClassName={`text-[14px]! font-normal! ${GHOST_INPUT_PLACEHOLDER_CLASS}`}
      data-testid={dataTestId}
    />
  );
}

export function CreateComposerHeader({
  children,
  dataTestId,
}: {
  children?: ReactNode;
  dataTestId: string;
}) {
  return (
    <div data-testid={dataTestId}>
      <div className="flex h-8 items-center px-1.5 py-0">{children}</div>
      <div className="px-2" aria-hidden>
        <div className="border-t border-border-2" />
      </div>
    </div>
  );
}

export function CreateComposerPinnedActions({
  children,
  dataTestId,
}: {
  children?: ReactNode;
  dataTestId: string;
}) {
  return (
    <PropertyDropdownDirectionProvider direction="up">
      <div
        className="flex min-w-0 flex-nowrap items-center gap-1.5"
        data-testid={dataTestId}
      >
        {children}
      </div>
    </PropertyDropdownDirectionProvider>
  );
}

export interface ManualCreateEditorRef {
  insertFilePill: (filePath: string, displayName?: string) => void;
  triggerAtMention: () => void;
  triggerSlashContext: () => void;
}

export interface ManualCreateComposerProps {
  dataTestId?: string;
  editorContent: ReactNode;
  editorRef: RefObject<ManualCreateEditorRef | null>;
  headerContent: ReactNode;
  pinnedActionsContent: ReactNode;
  /** Pill controls rendered after the + button. */
  pills?: ReactNode;
  submitButton?: ReactNode;
}

/** Shared manual-create shell for Project and Work Item composers. */
export function ManualCreateComposer({
  dataTestId,
  editorContent,
  editorRef,
  headerContent,
  pinnedActionsContent,
  pills,
  submitButton,
}: ManualCreateComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFilesSelected = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      Array.from(event.target.files ?? []).forEach((file) => {
        editorRef.current?.insertFilePill(file.name, file.name);
      });
      event.target.value = "";
    },
    [editorRef]
  );

  return (
    <div
      className={`session-creator-chat-panel-wrapper ${CHAT_PANEL_WIDTH_TOKENS.headerWidth} w-full shrink-0 ${COMPOSER_HORIZONTAL_GUTTER_CLASS}`}
      data-testid={dataTestId}
    >
      <div
        className={`mx-auto flex min-h-0 w-full flex-col gap-3 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
      >
        {/* Skills/actions stay above the input, independently of the trail. */}
        <div className="scrollbar-hide flex w-full min-w-0 items-center overflow-x-auto px-1 py-0.5">
          {pinnedActionsContent}
        </div>
        <div className="session-creator-chat-panel-fullscreen-composer-group session-creator-chat-panel-fullscreen-composer composer-bottom-glow relative w-full">
          <ComposerSurface
            className="session-creator-chat-panel-fullscreen-input-shell relative z-2 pt-1.5!"
            onAddContent={() => editorRef.current?.triggerAtMention()}
            onUpload={() => fileInputRef.current?.click()}
            onOpenSkillsTools={() => editorRef.current?.triggerSlashContext()}
            dropdownDirection="up"
            showContextInfo={false}
            pills={pills}
            trailingActions={submitButton}
          >
            {headerContent}
            <div className="min-h-0 px-1.5">{editorContent}</div>
          </ComposerSurface>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
            tabIndex={-1}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
