import type { ReactNode, RefObject } from "react";
import { useCallback, useRef } from "react";

import ComposerSurface from "@src/components/ComposerSurface";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";
import { PropertyDropdownDirectionProvider } from "@src/components/PropertyField/PropertyDropdownDirection";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";

export interface CreateComposerTitleInputProps {
  dataTestId: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}

/** Title field shared by Project and Work Item create composers. */
export function CreateComposerTitleInput({
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
      autoFocus
      fieldVariant="ghost"
      size="small"
      className="flex-1 focus-within:!bg-transparent hover:!bg-transparent"
      inputClassName={`!text-[14px] !font-normal ${GHOST_INPUT_PLACEHOLDER_CLASS}`}
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
      <div className="flex h-8 items-center px-1 py-0">{children}</div>
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
  submitButton?: ReactNode;
}

/** Shared manual-create shell for Project and Work Item composers. */
export function ManualCreateComposer({
  dataTestId,
  editorContent,
  editorRef,
  headerContent,
  pinnedActionsContent,
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
      className={`session-creator-chat-panel-wrapper ${DETAIL_PANEL_TOKENS.headerWidth} w-full shrink-0 px-4`}
      data-testid={dataTestId}
    >
      <div
        className={`mx-auto flex min-h-0 w-full flex-col gap-3 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
      >
        <div className="flex w-full min-w-0 items-center overflow-x-auto px-1 py-0.5 scrollbar-hide">
          {pinnedActionsContent}
        </div>
        <div className="session-creator-chat-panel-fullscreen-composer relative w-full">
          <ComposerSurface
            className="session-creator-chat-panel-fullscreen-input-shell composer-breathing relative z-10 !pt-1.5"
            onAddContent={() => editorRef.current?.triggerAtMention()}
            onUpload={() => fileInputRef.current?.click()}
            onOpenSkillsTools={() => editorRef.current?.triggerSlashContext()}
            dropdownDirection="up"
            showContextInfo={false}
            trailingActions={submitButton}
          >
            {headerContent}
            <div className="min-h-0 px-1">{editorContent}</div>
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
