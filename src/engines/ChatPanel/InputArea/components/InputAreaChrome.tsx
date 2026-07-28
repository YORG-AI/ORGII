import React from "react";
import { useTranslation } from "react-i18next";

import { ChatStatusSegmentedBar } from "@src/engines/ChatPanel/components/ChatStatusBanners";

import ChatHeader from "../ChatHeader";
import EditModeImageThumbnail from "./EditModeImageThumbnail";
import ImageAttachmentPreview from "./ImageAttachmentPreview";
import PinnedActionsBar from "./PinnedActionsBar";
import PlanTodoPill from "./PlanTodoPill";

interface TopRowsProps {
  isEditMode: boolean;
  omitChatHeader: boolean;
  topRowPills?: React.ReactNode;
  topRowTrailingContent?: React.ReactNode;
  composerInputRef: React.ComponentProps<
    typeof PinnedActionsBar
  >["composerInputRef"];
  sessionId?: string;
  skillWorkspacePaths?: string[];
}

export const InputAreaTopRows: React.FC<TopRowsProps> = ({
  isEditMode,
  omitChatHeader,
  topRowPills,
  topRowTrailingContent,
  composerInputRef,
  sessionId,
  skillWorkspacePaths,
}) => (
  <>
    {!isEditMode && !omitChatHeader && <ChatHeader />}
    {!isEditMode && (
      <div className="relative z-10 flex min-w-0 items-center gap-1 px-0.5 pb-1.5">
        <PinnedActionsBar
          composerInputRef={composerInputRef}
          sessionId={sessionId}
          workspacePaths={skillWorkspacePaths ?? undefined}
          leadingContent={
            <>
              <PlanTodoPill sessionId={sessionId} />
              {topRowPills}
            </>
          }
          trailingContent={topRowTrailingContent}
        />
      </div>
    )}
  </>
);

interface QuietEditStatusProps {
  isEditMode: boolean;
  quietEditSurface: boolean;
  showEditHeader: boolean;
  editLabel?: string;
}

export const QuietEditStatus: React.FC<QuietEditStatusProps> = ({
  isEditMode,
  quietEditSurface,
  showEditHeader,
  editLabel,
}) => {
  const { t } = useTranslation("sessions");

  if (!isEditMode || !quietEditSurface || !showEditHeader) return null;

  return (
    <ChatStatusSegmentedBar
      testId="sent-edit-mode-card"
      segments={[
        {
          key: "label",
          className: "flex-1",
          content: (
            <span className="truncate font-medium">
              {editLabel ?? t("input.editingSentMessage")}
            </span>
          ),
        },
      ]}
    />
  );
};

interface EditImagePreviewsProps {
  isEditMode: boolean;
  editImages?: string[];
  dropTargetId: string;
  onRemoveEditImage?: (index: number) => void;
}

export const EditImagePreviews: React.FC<EditImagePreviewsProps> = ({
  isEditMode,
  editImages,
  dropTargetId,
  onRemoveEditImage,
}) => {
  if (!isEditMode) return null;

  return (
    <>
      {editImages && editImages.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-0.5">
          {editImages.map((dataUrl, imageIndex) => (
            <EditModeImageThumbnail
              key={imageIndex}
              dataUrl={dataUrl}
              alt={`Attached image ${imageIndex + 1}`}
              onRemove={
                onRemoveEditImage
                  ? () => onRemoveEditImage(imageIndex)
                  : undefined
              }
            />
          ))}
        </div>
      )}
      <ImageAttachmentPreview ownerId={dropTargetId} className="px-6 pb-0.5" />
    </>
  );
};

export const getComposerShellVariant = ({
  compactShell,
  isEditMode,
  quietEditSurface,
  surfaceBg,
}: {
  compactShell: boolean;
  isEditMode: boolean;
  quietEditSurface: boolean;
  surfaceBg: boolean;
}) => {
  if (compactShell) return "pill";
  if (isEditMode) return quietEditSurface ? "historyEdit" : "embedded";
  return surfaceBg ? "default" : "embedded";
};

export const getComposerShellClassName = ({
  isDragOver,
  isEditMode,
  quietEditSurface,
}: {
  isDragOver: boolean;
  isEditMode: boolean;
  quietEditSurface: boolean;
}): string | undefined => {
  if (isDragOver) {
    return "!border-primary-6 !bg-[color-mix(in_srgb,var(--color-primary-6)_5%,var(--color-chat-input))] !shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_20%,transparent)]";
  }
  if (!isEditMode) return "composer-breathing";
  if (quietEditSurface) {
    return "!border-warning-6 !shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-warning-6)_15%,transparent)]";
  }
  return undefined;
};
