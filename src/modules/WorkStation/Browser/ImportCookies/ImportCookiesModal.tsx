/**
 * ImportCookiesModal
 *
 * Lets the user carry saved logins from another installed browser into the
 * app's built-in browser: pick a source profile, review the sites it holds
 * cookies for (money / mail / SSO unchecked by default), and import the chosen
 * ones. Mirrors the built-in-browser "import cookies" affordance.
 *
 * Footers are the design-system blocks: the source picker has none (a row
 * click advances, the header X closes); the checklist uses `PanelFooter` — the
 * same block Modal renders by default — with Select all and the selection
 * summary in its `left` slot and Cancel / "Import N sites" on the right; the
 * summary uses Modal's own `onOk` / `okText` for a lone "Done".
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import type {
  CookieImportSource,
  CookieSiteCategory,
  CookieSiteGroup,
} from "@src/api/tauri/browserCookies";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import { IconButton } from "@src/components/IconButton";
import { InlineBanner } from "@src/components/InlineBanner";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  HugeiconsIcon,
  type IconSvgElement,
  InformationCircleIcon,
  InternetIcon,
  Key01Icon,
  Loading03Icon,
  Mail01Icon,
  Shield01Icon,
} from "@src/icons";
import PanelFooter from "@src/modules/shared/layouts/blocks/PanelFooter";
import Modal from "@src/scaffold/ModalSystem";

import { selectAllState, selectedCookieCount } from "./importCookiesSelection";
import {
  type ImportCookiesController,
  useImportCookiesController,
} from "./useImportCookiesController";

/**
 * Mount this only while the flow is open: the controller discovers sources on
 * mount and unmounting is what resets the flow for the next open.
 */
interface ImportCookiesModalProps {
  onClose: () => void;
  /** Fired after a successful import, e.g. to reload the active tab. */
  onImported?: () => void;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const CAUTION_BADGE: Record<
  Exclude<CookieSiteCategory, "general">,
  { icon: IconSvgElement; labelKey: string }
> = {
  banking: {
    icon: Shield01Icon,
    labelKey: "browserCookieImport.category.banking",
  },
  email: { icon: Mail01Icon, labelKey: "browserCookieImport.category.email" },
  sso: { icon: Key01Icon, labelKey: "browserCookieImport.category.sso" },
};

function Spinner() {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      size={16}
      className="animate-spin text-text-3"
      aria-hidden
    />
  );
}

const SourceRow = memo<{
  source: CookieImportSource;
  onSelect: (id: string) => void;
}>(({ source, onSelect }) => {
  const { t } = useTranslation();
  const blocked = source.unavailableReason !== null;
  // A blocked source (Safari without Full Disk Access) explains itself on the
  // second line and opens the hint instead of a preview.
  const subtitle = blocked
    ? t("browserCookieImport.safari.needsFullDiskAccess")
    : source.profileLabel;
  return (
    <button
      type="button"
      onClick={() => onSelect(source.id)}
      className="flex w-full items-center gap-3 rounded-lg border border-border-1 bg-fill-1 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
    >
      <HugeiconsIcon
        icon={InternetIcon}
        size={18}
        className="shrink-0 text-text-2"
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-1">
          {source.browserLabel}
        </span>
        {subtitle ? (
          <span
            className={`block truncate text-xs ${blocked ? "text-warning-6" : "text-text-3"}`}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
      <HugeiconsIcon
        icon={blocked ? InformationCircleIcon : ArrowRight01Icon}
        size={16}
        className="shrink-0 text-text-3"
        aria-hidden
      />
    </button>
  );
});
SourceRow.displayName = "SourceRow";

const SiteRow = memo<{
  site: CookieSiteGroup;
  checked: boolean;
  onToggle: (domain: string) => void;
}>(({ site, checked, onToggle }) => {
  const { t } = useTranslation();
  const badge =
    site.category === "general" ? null : CAUTION_BADGE[site.category];
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-fill-2">
      <Checkbox
        checked={checked}
        onCheckedChange={() => onToggle(site.domain)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-1">
          {site.domain}
        </span>
        <span className="block truncate text-xs text-text-3">
          {t("browserCookieImport.cookieCount", { count: site.cookieCount })}
        </span>
      </span>
      {badge ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-warning-1 px-2 py-0.5 text-[11px] text-warning-6">
          <HugeiconsIcon icon={badge.icon} size={11} aria-hidden />
          {t(badge.labelKey)}
        </span>
      ) : null}
    </label>
  );
});
SiteRow.displayName = "SiteRow";

function SourcesStage({
  controller,
  t,
}: {
  controller: ImportCookiesController;
  t: Translate;
}) {
  if (controller.sourcesLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-3">
        <Spinner />
        {t("browserCookieImport.scanning")}
      </div>
    );
  }
  if (controller.sources.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <HugeiconsIcon
          icon={InternetIcon}
          size={28}
          className="text-text-4"
          aria-hidden
        />
        <p className="text-sm text-text-2">
          {t("browserCookieImport.empty.title")}
        </p>
        <p className="text-xs text-text-3">
          {t("browserCookieImport.empty.body")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {controller.sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            onSelect={controller.selectSource}
          />
        ))}
      </div>
      {controller.unavailableSource ? (
        <div className="flex flex-col gap-2 rounded-lg bg-fill-1 px-3 py-2.5">
          <p className="text-xs text-text-2">
            {t("browserCookieImport.safari.explain")}
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="small"
              onClick={controller.openFullDiskAccessSettings}
            >
              {t("browserCookieImport.safari.openSettings")}
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={controller.refreshSources}
            >
              {t("browserCookieImport.safari.checkAgain")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PreviewStage({
  controller,
  t,
}: {
  controller: ImportCookiesController;
  t: Translate;
}) {
  const sites = controller.preview?.sites ?? [];

  if (controller.previewLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-text-3">
        <Spinner />
        <span>
          {t("browserCookieImport.reading", {
            browser: controller.activeSource?.browserLabel ?? "",
          })}
        </span>
        <span className="text-xs text-text-4">
          {t("browserCookieImport.keychainHint")}
        </span>
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3">
        {t("browserCookieImport.noSites")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {controller.preview?.warning ? (
        <InlineBanner tone="warning">{controller.preview.warning}</InlineBanner>
      ) : null}

      <div className="max-h-[320px] overflow-y-auto pr-1">
        {sites.map((site) => (
          <SiteRow
            key={site.domain}
            site={site}
            checked={controller.selectedDomains.has(site.domain)}
            onToggle={controller.toggleDomain}
          />
        ))}
      </div>

      <p className="px-2 pt-1 text-[11px] text-text-4">
        {t("browserCookieImport.cautionNote")}
      </p>
    </div>
  );
}

function DoneStage({
  controller,
  t,
}: {
  controller: ImportCookiesController;
  t: Translate;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        size={30}
        className="text-success-6"
        aria-hidden
      />
      <p className="text-sm text-text-1">
        {t("browserCookieImport.doneTitle", {
          count: controller.result?.importedCookies ?? 0,
        })}
      </p>
      {controller.result && controller.result.skippedCookies > 0 ? (
        <p className="text-xs text-text-3">
          {t("browserCookieImport.doneSkipped", {
            count: controller.result.skippedCookies,
          })}
        </p>
      ) : null}
    </div>
  );
}

/** Checklist footer: Select all + summary on the left, Cancel / Import right. */
function PreviewFooter({
  controller,
  onClose,
  t,
}: {
  controller: ImportCookiesController;
  onClose: () => void;
  t: Translate;
}) {
  const { previewLoading, importing, selectedDomains } = controller;
  const sites = controller.preview?.sites ?? [];
  const selectAll = selectAllState(sites, selectedDomains);

  const selection =
    !previewLoading && sites.length > 0 ? (
      <>
        <Checkbox
          checked={selectAll === "all"}
          indeterminate={selectAll === "some"}
          disabled={importing}
          onCheckedChange={(checked) => controller.setAllDomains(checked)}
        >
          <span className="text-xs text-text-2">
            {t("browserCookieImport.selectAll")}
          </span>
        </Checkbox>
        <span className="truncate text-xs text-text-3">
          {t("browserCookieImport.selectedSummary", {
            sites: selectedDomains.size,
            cookies: selectedCookieCount(sites, selectedDomains),
          })}
        </span>
      </>
    ) : undefined;

  return (
    <PanelFooter
      left={selection}
      secondaryActions={[
        {
          label: t("actions.cancel"),
          onClick: onClose,
          disabled: importing,
        },
      ]}
      primaryAction={{
        label: t("browserCookieImport.importAction", {
          count: selectedDomains.size,
        }),
        onClick: controller.runImport,
        disabled: previewLoading || importing || selectedDomains.size === 0,
        loading: importing,
      }}
    />
  );
}

export const ImportCookiesModal: React.FC<ImportCookiesModalProps> = ({
  onClose,
  onImported,
}) => {
  const { t } = useTranslation();
  const controller = useImportCookiesController(onImported);
  const { stage, importing } = controller;

  const backAction =
    stage === "preview" && !importing ? (
      <IconButton
        onClick={controller.backToSources}
        aria-label={t("actions.back")}
        title={t("actions.back")}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
      </IconButton>
    ) : undefined;

  // Summary stage: Modal's own footer with a lone "Done" (empty cancelText
  // hides the secondary button). Other stages leave these unset.
  const doneFooterProps =
    stage === "done"
      ? { onOk: onClose, okText: t("actions.done"), cancelText: "" }
      : {};

  return (
    <Modal
      visible
      onClose={onClose}
      title={t("browserCookieImport.title")}
      width={520}
      headerActions={backAction}
      maskClosable={!importing}
      escToExit={!importing}
      footer={
        stage === "preview" ? (
          <PreviewFooter controller={controller} onClose={onClose} t={t} />
        ) : undefined
      }
      {...doneFooterProps}
    >
      <div className="min-h-[200px]">
        {stage === "sources" ? (
          <SourcesStage controller={controller} t={t} />
        ) : stage === "preview" ? (
          <PreviewStage controller={controller} t={t} />
        ) : (
          <DoneStage controller={controller} t={t} />
        )}
      </div>
    </Modal>
  );
};

ImportCookiesModal.displayName = "ImportCookiesModal";

export default ImportCookiesModal;
