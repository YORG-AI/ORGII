import type { ReactNode, RefObject } from "react";
import { useCallback, useRef } from "react";

import ComposerBar from "@src/components/ComposerBar";
import ComposerShell from "@src/components/ComposerShell";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";
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
      <div className="flex h-10 items-center px-1 py-0">{children}</div>
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
    <div
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
      data-testid={dataTestId}
    >
      {children}
    </div>
  );
}

export function CreateComposerAgentFrame({
  centered = false,
  children,
}: {
  centered?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={centered ? "shrink-0" : "min-h-0 flex-1 overflow-hidden pt-6"}
    >
      {children}
    </div>
  );
}

export interface ManualCreateEditorRef {
  insertFilePill: (filePath: string, displayName?: string) => void;
  triggerAtMention: () => void;
  triggerSlashContext: () => void;
}

export interface ManualCreateComposerProps {
  centered?: boolean;
  dataTestId?: string;
  editorContent: ReactNode;
  editorRef: RefObject<ManualCreateEditorRef | null>;
  headerContent: ReactNode;
  pinnedActionsContent: ReactNode;
  submitButton?: ReactNode;
}

/** Shared manual-create shell for Project and Work Item composers. */
export function ManualCreateComposer({
  centered = false,
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
      className={`session-creator-chat-panel-wrapper ${
        centered
          ? `${DETAIL_PANEL_TOKENS.headerWidth} shrink-0 px-4`
          : "min-h-0 flex-1 overflow-hidden pt-6"
      }`}
      data-testid={dataTestId}
    >
      <div
        className={`mx-auto flex min-h-0 w-full flex-col ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
      >
        <div className="session-creator-chat-panel-fullscreen-composer relative w-full">
          <ComposerShell className="session-creator-chat-panel-fullscreen-input-shell relative z-10 !pt-1.5">
            {headerContent}
            <div className="min-h-0 px-1">{editorContent}</div>
            <ComposerBar
              onAddContent={() => editorRef.current?.triggerAtMention()}
              onUpload={() => fileInputRef.current?.click()}
              onOpenSkillsTools={() => editorRef.current?.triggerSlashContext()}
              dropdownDirection="down"
              toolbarItemGap={false}
              showContextInfo={false}
              pills={
                <>
                  <div
                    aria-hidden
                    className="mx-1 h-4 w-px shrink-0 bg-border-2"
                  />
                  <div className="flex min-w-0 items-center overflow-x-auto scrollbar-hide">
                    {pinnedActionsContent}
                  </div>
                </>
              }
              submitButton={submitButton}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFilesSelected}
              tabIndex={-1}
              aria-hidden
            />
          </ComposerShell>
        </div>
      </div>
    </div>
  );
}
