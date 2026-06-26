import { useAtomValue, useSetAtom } from "jotai";
import { type MutableRefObject, type RefObject, useEffect } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import i18n from "@src/i18n";
import {
  clearDroppedFilesAtom,
  droppedFilesAtom,
} from "@src/store/ui/dragDropAtom";

import { isImageName } from "./imageExtensions";

interface UseDroppedFilesConsumerOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
  dropTargetId: string;
  hasContentRef: MutableRefObject<boolean>;
  handleImagePaste: (files: File[]) => Promise<void>;
  handleImagePath: (path: string, fileName?: string) => Promise<void>;
}

export function useDroppedFilesConsumer({
  composerInputRef,
  dropTargetId,
  hasContentRef,
  handleImagePaste,
  handleImagePath,
}: UseDroppedFilesConsumerOptions): void {
  const droppedFiles = useAtomValue(droppedFilesAtom);
  const clearDroppedFiles = useSetAtom(clearDroppedFilesAtom);

  useEffect(() => {
    if (droppedFiles.length === 0) return;

    const filesForThisTarget = droppedFiles.filter(
      (file) => !file.dropTargetId || file.dropTargetId === dropTargetId
    );
    if (filesForThisTarget.length === 0) return;

    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    const imageFiles = filesForThisTarget.filter(
      (file) =>
        file.type !== "folder" &&
        (file.browserFile?.type.startsWith("image/") || isImageName(file.name))
    );
    const otherFiles = filesForThisTarget.filter(
      (file) => file.type === "folder" || !imageFiles.includes(file)
    );

    const browserImageFiles = imageFiles
      .map((file) => file.browserFile)
      .filter((file): file is File => Boolean(file));
    const pathImageFiles = imageFiles.filter((file) => !file.browserFile);

    const imagePromises: Promise<void>[] = [];

    if (browserImageFiles.length > 0) {
      imagePromises.push(handleImagePaste(browserImageFiles));
    }

    if (pathImageFiles.length > 0) {
      imagePromises.push(
        ...pathImageFiles.map((file) => handleImagePath(file.path, file.name))
      );
    }

    if (otherFiles.length > 0) {
      const insertPills = () => {
        if (cancelled) return;

        if (composerInputRef.current) {
          otherFiles.forEach((file) => {
            const isFolder = file.type === "folder";
            composerInputRef.current?.insertFilePill(
              file.path,
              isFolder,
              isFolder ? "folder" : "file"
            );
          });
          hasContentRef.current = true;
          Message.success(
            i18n.t("toasts.addedFilesAsContext", { count: otherFiles.length })
          );
        } else {
          const timer = setTimeout(insertPills, 100);
          retryTimers.push(timer);
        }
      };

      insertPills();
    }

    void Promise.all(imagePromises).then(() => {
      if (!cancelled) clearDroppedFiles();
    });

    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => clearTimeout(timer));
    };
  }, [
    droppedFiles,
    dropTargetId,
    clearDroppedFiles,
    composerInputRef,
    hasContentRef,
    handleImagePath,
    handleImagePaste,
  ]);
}
