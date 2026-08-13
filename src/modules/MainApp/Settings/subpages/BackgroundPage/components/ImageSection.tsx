/**
 * ImageSection Component
 * Preset thumbnails, custom uploads, and + file picker in one row (aligned with ColorSection).
 */
import Button from "@/src/components/Button";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_PATH_TEXT_CLASSES,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { invoke } from "@tauri-apps/api/core";
import { Copy, FolderOpen, Plus, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import Slider from "@src/components/Slider";
import { copyText } from "@src/util/data/clipboard";

import { PRESET_IMAGES } from "../config";
import type { BackgroundConfig } from "../types";

const IMAGE_TILE_BASE =
  "relative shrink-0 w-[88px] overflow-hidden rounded-lg border border-solid transition-[border-color,box-shadow] duration-150 ease-out";
const IMAGE_TILE_IDLE =
  "border-border-2 hover:border-border-3 focus-visible:outline-none focus-visible:border-primary-6 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";
const IMAGE_TILE_SELECTED =
  "border-primary-6 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";

interface ImageSectionProps {
  config: BackgroundConfig;
  images: Map<string, string>;
  storagePath: string;
  isOptimizing: boolean;
  translationNamespace: string;
  onBlurChange: (val: number | number[]) => void;
  onImageSelect: (imageUrl: string, imageId?: string) => void;
  onUpload: (file: File) => Promise<boolean>;
  onDeleteCustomImage: (
    event: React.MouseEvent,
    imageId: string
  ) => Promise<void>;
}

export const ImageSection: React.FC<ImageSectionProps> = ({
  config,
  images,
  storagePath,
  isOptimizing,
  translationNamespace,
  onBlurChange,
  onImageSelect,
  onUpload,
  onDeleteCustomImage,
}) => {
  const { t } = useTranslation(translationNamespace);
  const hasStoragePath = storagePath.trim().length > 0;
  const blurAmount = config.blurAmount ?? 0;
  const isGlass = config.glass != null;

  const customImageEntries = (config.customImages ?? [])
    .filter(
      (imageId): imageId is string =>
        typeof imageId === "string" && !imageId.startsWith("data:")
    )
    .flatMap((imageId) => {
      const imageDataUrl = images.get(imageId);
      return imageDataUrl ? [{ imageId, imageDataUrl }] : [];
    });

  return (
    <>
      <SectionRow label={t("background.images")} layout="vertical">
        <div className="flex flex-wrap gap-2">
          {PRESET_IMAGES.map((img, index) => {
            const isPresetSelected =
              !config.backgroundColor &&
              !config.glass &&
              (config.imageUrl === img.value ||
                (!config.imageUrl && !config.selectedImageId && index === 0));

            return (
              <button
                key={`${img.value}-${index}`}
                type="button"
                title={img.label}
                className={`${IMAGE_TILE_BASE} block cursor-pointer p-0 text-left ${isPresetSelected ? IMAGE_TILE_SELECTED : IMAGE_TILE_IDLE}`}
                onClick={() => onImageSelect(img.value)}
              >
                <div className="relative aspect-video w-full overflow-hidden bg-primary-container">
                  <img
                    src={img.thumbnail}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              </button>
            );
          })}

          {customImageEntries.map(({ imageId, imageDataUrl }, index) => {
            const isSelected = config.selectedImageId === imageId;

            return (
              <div key={imageId} className="group relative shrink-0">
                <button
                  type="button"
                  title={`${t("background.custom")} ${index + 1}`}
                  className={`${IMAGE_TILE_BASE} block w-[88px] cursor-pointer p-0 text-left ${isSelected ? IMAGE_TILE_SELECTED : IMAGE_TILE_IDLE}`}
                  onClick={() => onImageSelect(imageDataUrl, imageId)}
                >
                  <div className="relative aspect-video w-full bg-primary-container">
                    <img
                      src={imageDataUrl}
                      alt={`Custom ${index + 1}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                </button>
                <Button
                  className="absolute -right-0.5 -top-0.5 z-10 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                  style={{ width: 18, height: 18, minWidth: 18 }}
                  variant="secondary"
                  appearance="solid"
                  size="mini"
                  shape="circle"
                  icon={<X size={9} strokeWidth={2.25} />}
                  iconOnly
                  title={t("common:actions.delete")}
                  onClick={(event) => onDeleteCustomImage(event, imageId)}
                />
              </div>
            );
          })}

          <label
            className={`${IMAGE_TILE_BASE} flex aspect-video w-[88px] cursor-pointer items-center justify-center bg-primary-container text-text-3 ${
              isOptimizing
                ? "pointer-events-none cursor-not-allowed border-border-2 opacity-40"
                : IMAGE_TILE_IDLE
            }`}
            title={
              isOptimizing
                ? t("background.optimizing")
                : t("background.uploadButton")
            }
            aria-label={t("background.uploadButton")}
          >
            <input
              type="file"
              accept="image/*"
              disabled={isOptimizing}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onUpload(file);
                event.target.value = "";
              }}
            />
            <Plus
              size={14}
              strokeWidth={2.25}
              className="pointer-events-none"
            />
          </label>
        </div>
      </SectionRow>

      {!isGlass && !config.backgroundColor && (
        <SectionRow label={t("background.blur")}>
          <div
            className="flex items-center gap-2"
            style={SECTION_CONTROL_STYLE}
          >
            <div className="min-w-0 flex-1">
              <Slider
                min={0}
                max={20}
                value={config.blurAmount}
                onChange={onBlurChange}
                noPadding
              />
            </div>
            <span className="w-10 shrink-0 text-right text-sm text-text-3">
              {blurAmount}px
            </span>
          </div>
        </SectionRow>
      )}

      <SectionRow
        label={t("storage.dataDirectory")}
        description={t("storage.dataDirectoryDesc")}
      >
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <span className={SECTION_PATH_TEXT_CLASSES}>
            {hasStoragePath ? storagePath : "—"}
          </span>
          <Button
            disabled={!hasStoragePath}
            onClick={() => {
              void copyText(storagePath).then(() => {
                Message.success(t("storage.copiedPath"));
              });
            }}
            icon={<Copy size={14} />}
            iconOnly
            title={t("common:actions.copy")}
          />
          <Button
            disabled={!hasStoragePath}
            onClick={() => invoke("open_folder", { path: storagePath })}
            icon={<FolderOpen size={14} />}
            iconOnly
            title={t("storage.openFolder")}
          />
        </div>
      </SectionRow>
    </>
  );
};
