import type { TFunction } from "i18next";

import { Message } from "@src/components/Message";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";

import type { SessionValidationResult } from "../useSessionValidation";

const MIN_INPUT_LENGTH = 15;

export function showValidationErrors(
  validation: SessionValidationResult,
  t: TFunction
): void {
  Message.error({
    content: (
      <div>
        <div className="font-medium">{t("common:errors.validation")}:</div>
        <ul className="mt-1 list-inside list-disc text-[12px]">
          {validation.errors.map((errorMessage, index) => (
            <li key={index}>{errorMessage}</li>
          ))}
        </ul>
      </div>
    ),
    duration: 5000,
  });
}

export async function confirmShortInputIfNeeded(
  editorContent: string,
  t: TFunction
): Promise<boolean> {
  const trimmedContent = editorContent.trim();
  if (
    trimmedContent.length === 0 ||
    trimmedContent.length >= MIN_INPUT_LENGTH
  ) {
    return true;
  }

  try {
    return askNativeDialogSafely(t("creator.shortInputMessage"), {
      title: t("creator.shortInputTitle"),
      kind: "warning",
      okLabel: t("common:actions.continue"),
      cancelLabel: t("common:actions.cancel"),
    });
  } catch {
    return window.confirm(t("creator.shortInputMessage"));
  }
}
