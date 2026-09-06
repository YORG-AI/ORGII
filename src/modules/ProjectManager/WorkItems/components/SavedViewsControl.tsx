import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import {
  type SavedView,
  type SavedViewDisplay,
  type SavedViewQuery,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import { BookBookmark01Icon, Delete02Icon, HugeiconsIcon } from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";

import {
  getActiveSavedViewId,
  readSavedViewDisplayPreference,
  resolveSavedViewDisplay,
  savedViewDisplayFingerprint,
  setActiveSavedViewId,
  writeSavedViewDisplayPreference,
} from "../savedViewPreferences";

const EMPTY_SAVED_VIEWS: SavedView[] = [];

export interface SavedViewsControlProps {
  orgId: string;
  projectSlug: string | null;
  preferenceOwnerId: string;
  currentQuery: SavedViewQuery;
  currentDisplay: SavedViewDisplay;
  onApply: (view: SavedView, display: SavedViewDisplay) => void;
}

export const SavedViewsControl: React.FC<SavedViewsControlProps> = ({
  orgId,
  projectSlug,
  preferenceOwnerId,
  currentQuery,
  currentDisplay,
  onApply,
}) => {
  const { t } = useTranslation("projects");
  const location = useLocation();
  const navigate = useNavigate();
  const scopeKey = JSON.stringify([orgId, projectSlug]);
  const [viewsSnapshot, setViewsSnapshot] = useState<{
    scopeKey: string;
    views: SavedView[];
  } | null>(null);
  const views =
    viewsSnapshot?.scopeKey === scopeKey
      ? viewsSnapshot.views
      : EMPTY_SAVED_VIEWS;
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);
  const refreshGenerationRef = useRef(0);
  const appliedViewKeyRef = useRef("");
  const pendingDisplayHydrationRef = useRef<{
    viewId: string;
    sourceFingerprint: string;
  } | null>(null);
  const currentDisplayRef = useRef(currentDisplay);
  currentDisplayRef.current = currentDisplay;

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    try {
      const nextViews = await projectApi.listSavedViews(orgId, projectSlug);
      if (generation === refreshGenerationRef.current) {
        setViewsSnapshot({ scopeKey, views: nextViews });
      }
    } catch {
      // Keep the last successfully loaded view list.
    }
  }, [orgId, projectSlug, scopeKey]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  const preferenceScope = useMemo(
    () => ({ orgId, projectSlug, ownerId: preferenceOwnerId }),
    [orgId, preferenceOwnerId, projectSlug]
  );
  const activeViewId = getActiveSavedViewId(location.search);
  const selectedView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? null,
    [activeViewId, views]
  );
  const selectedId = selectedView?.id ?? null;
  const currentDisplayFingerprint = savedViewDisplayFingerprint(currentDisplay);

  const setActiveView = useCallback(
    (viewId: string | null, replace = false) => {
      void navigate(
        {
          pathname: location.pathname,
          search: setActiveSavedViewId(location.search, viewId),
          hash: location.hash,
        },
        { replace }
      );
    },
    [location.hash, location.pathname, location.search, navigate]
  );

  useEffect(() => {
    if (!selectedView) {
      appliedViewKeyRef.current = "";
      pendingDisplayHydrationRef.current = null;
      return;
    }
    const applyKey = `${scopeKey}:${preferenceOwnerId}:${selectedView.id}:${selectedView.updatedAt}`;
    if (appliedViewKeyRef.current === applyKey) return;

    const personalDisplay = readSavedViewDisplayPreference(
      preferenceScope,
      selectedView.id
    );
    const display = resolveSavedViewDisplay(
      selectedView.display,
      personalDisplay
    );
    writeSavedViewDisplayPreference(preferenceScope, selectedView.id, display);
    appliedViewKeyRef.current = applyKey;
    const sourceFingerprint = savedViewDisplayFingerprint(
      currentDisplayRef.current
    );
    pendingDisplayHydrationRef.current =
      sourceFingerprint === savedViewDisplayFingerprint(display)
        ? null
        : { viewId: selectedView.id, sourceFingerprint };
    onApply(selectedView, display);
  }, [onApply, preferenceOwnerId, preferenceScope, scopeKey, selectedView]);

  useEffect(() => {
    if (!selectedView) return;
    const pending = pendingDisplayHydrationRef.current;
    if (pending?.viewId === selectedView.id) {
      // The selection effect runs before this persistence effect, while the
      // parent still exposes the previous view's layout. Skip only that stale
      // snapshot; the next actual layout (target or user-adjusted) is personal.
      if (pending.sourceFingerprint === currentDisplayFingerprint) return;
      pendingDisplayHydrationRef.current = null;
    }
    writeSavedViewDisplayPreference(
      preferenceScope,
      selectedView.id,
      currentDisplayRef.current
    );
  }, [currentDisplayFingerprint, preferenceScope, selectedView]);

  const options = useMemo(
    () =>
      views.map((view) => ({
        value: view.id,
        label: view.name,
      })),
    [views]
  );

  const handleSelect = useCallback(
    (id: string) => {
      setActiveView(id);
    },
    [setActiveView]
  );

  const handleSave = useCallback(async () => {
    if (!draftName.trim()) return;
    setSaving(true);
    try {
      const view = await projectApi.upsertSavedView({
        orgId,
        projectSlug,
        name: draftName.trim(),
        query: currentQuery,
        display: currentDisplay,
      });
      setDraftName("");
      setSaveOpen(false);
      setViewsSnapshot((current) => ({
        scopeKey,
        views: [
          ...(current?.scopeKey === scopeKey ? current.views : []).filter(
            (candidate) => candidate.id !== view.id
          ),
          view,
        ],
      }));
      setActiveView(view.id);
      void refresh();
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSaving(false);
    }
  }, [
    currentDisplay,
    currentQuery,
    draftName,
    orgId,
    projectSlug,
    refresh,
    scopeKey,
    setActiveView,
  ]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    try {
      await projectApi.archiveSavedView(orgId, selectedId);
      setActiveView(null, true);
      void refresh();
    } catch (error) {
      Message.error(String(error));
    }
  }, [orgId, refresh, selectedId, setActiveView]);

  if (views.length === 0 && !saveOpen) {
    return (
      <>
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          iconOnly
          icon={
            <HugeiconsIcon
              icon={BookBookmark01Icon}
              data-icon="bookmark-plus"
              size={14}
            />
          }
          onClick={() => setSaveOpen(true)}
          aria-label={t("workItems.savedViews.save", {
            defaultValue: "Save current view",
          })}
          data-testid="work-items-saved-view-save"
        />
        {renderSaveModal()}
      </>
    );
  }

  function renderSaveModal() {
    return (
      <Modal
        visible={saveOpen}
        title={t("workItems.savedViews.saveTitle", {
          defaultValue: "Save view",
        })}
        width={380}
        onCancel={() => setSaveOpen(false)}
        onOk={() => void handleSave()}
        okText={t("common:actions.save", { defaultValue: "Save" })}
        cancelText={t("common:actions.cancel", { defaultValue: "Cancel" })}
        okButtonProps={{ disabled: !draftName.trim(), loading: saving }}
      >
        <div className="flex flex-col gap-2 p-4">
          <Input
            value={draftName}
            onChange={(value) => setDraftName(value)}
            placeholder={t("workItems.savedViews.namePlaceholder", {
              defaultValue: "View name",
            })}
            autoFocus
            data-testid="work-items-saved-view-name"
          />
          <p className="text-xs text-text-4">
            {t("workItems.savedViews.saveHint", {
              defaultValue:
                "Captures the current filters; layout seeds the first open.",
            })}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        value={selectedId ?? undefined}
        options={options}
        onChange={(value) => handleSelect(value as string)}
        placeholder={t("workItems.savedViews.placeholder", {
          defaultValue: "Views",
        })}
        appearance="ghost"
        size="small"
        dataTestId="work-items-saved-view-select"
      />
      <Button
        variant="tertiary"
        appearance="ghost"
        size="small"
        iconOnly
        icon={
          <HugeiconsIcon
            icon={BookBookmark01Icon}
            data-icon="bookmark-plus"
            size={14}
          />
        }
        onClick={() => setSaveOpen(true)}
        aria-label={t("workItems.savedViews.save", {
          defaultValue: "Save current view",
        })}
        data-testid="work-items-saved-view-save"
      />
      {selectedId ? (
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          iconOnly
          icon={
            <HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={14} />
          }
          onClick={() => void handleDelete()}
          aria-label={t("workItems.savedViews.delete", {
            defaultValue: "Delete view",
          })}
          data-testid="work-items-saved-view-delete"
        />
      ) : null}
      {renderSaveModal()}
    </div>
  );
};

export default SavedViewsControl;
