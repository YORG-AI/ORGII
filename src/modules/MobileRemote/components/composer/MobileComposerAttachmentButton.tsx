import React, { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { PILL_CONTROL_HOVER_CLASS } from "@src/components/CompoundPill/config";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { Add01Icon, HugeiconsIcon } from "@src/icons";

export interface MobileComposerAttachmentButtonProps {
  disabled?: boolean;
  busy?: boolean;
  onFilesSelected: (files: File[]) => void | Promise<void>;
}

export function MobileComposerAttachmentButton({
  disabled = false,
  busy = false,
  onFilesSelected,
}: MobileComposerAttachmentButtonProps) {
  const { t } = useTranslation("mobileRemote");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (disabled || busy) return;
    inputRef.current?.click();
  }, [busy, disabled]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;
      void Promise.resolve(onFilesSelected(files));
    },
    [onFilesSelected]
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        data-testid="mobile-composer-file-input"
        onChange={handleChange}
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || busy}
        className={[
          `flex items-center justify-center rounded-full text-text-1 transition-colors duration-200 focus:outline-none ${PILL_CONTROL_HOVER_CLASS}`,
          INPUT_AREA_BUTTONS.iconButtonSizeClass,
          disabled || busy ? "pointer-events-none opacity-50" : "",
        ].join(" ")}
        aria-label={t("composer.attachments.addPhotos")}
        title={t("composer.attachments.addPhotos")}
        data-testid="mobile-composer-attach-button"
      >
        <HugeiconsIcon
          icon={Add01Icon}
          data-icon="plus"
          size={INPUT_AREA_BUTTONS.iconSize}
          strokeWidth={1.75}
          className="text-text-1"
        />
      </button>
    </>
  );
}

MobileComposerAttachmentButton.displayName = "MobileComposerAttachmentButton";
