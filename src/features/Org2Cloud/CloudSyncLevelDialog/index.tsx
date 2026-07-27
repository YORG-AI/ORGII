/**
 * CloudSyncLevelDialog — per-session cloud access ladder editor (§13.4).
 *
 * Opened from the session context menu ("Cloud sync level…"). One row per
 * currently selected cloud org: a sync-level Select (Org minimum / Off /
 * Metadata only / Full replay) and a visibility Select (Everyone in org /
 * Only me). Personal/local scope exposes no cross-org sharing controls.
 * Writes land in the persisted `org2CloudAccessSettingsAtom` — the ratchet
 * store the push engine re-reads every pass — and kick a sync pass so
 * upgrades publish promptly. Downgrades stop FUTURE pushes; rows already on
 * the server keep their last pushed level until untagged/deleted (the 0010
 * server enforces reads by the persisted columns either way).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useAtom, useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import {
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import {
  COLLAB_SESSION_ACCESS_MODE,
  COLLAB_SESSION_VISIBILITY,
} from "@src/store/collaboration/types";
import type {
  CollabSessionAccessMode,
  CollabSessionVisibility,
} from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  floorAccessMode,
  getCloudOrgAccessSettings,
  getOrgSharingFloor,
  isAccessModeAtLeast,
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
  withCloudSessionMode,
  withCloudSessionVisibility,
} from "../org2CloudAccessSettings";
import {
  getSidebarActiveCloudOrg,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "../org2CloudOrgsAtom";
import { org2CloudSyncEngine } from "../org2CloudSyncEngine";

/** Sentinel select value for "no per-session override" (follow org minimum). */
const USE_ORG_MINIMUM = "__org_minimum__";
/** Ladder order for building the (floor-filtered) per-session mode options. */
const ACCESS_MODE_LADDER = [
  COLLAB_SESSION_ACCESS_MODE.OFF,
  COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
  COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
] as const;
/** Above the modal wrapper (9999) so the panel is not swallowed by the mask. */
const MODAL_SELECT_Z_INDEX = 10_000;

export interface CloudSyncLevelDialogProps {
  /** The owner's local session; null keeps the dialog closed. */
  session: Session | null;
  onClose: () => void;
}

const CloudSyncLevelDialog: React.FC<CloudSyncLevelDialogProps> = ({
  session,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const [accessByOrg, setAccessByOrg] = useAtom(org2CloudAccessSettingsAtom);
  const floorByOrg = useAtomValue(org2CloudSharingFloorAtom);
  const tags = useAtomValue(sessionOrgTagsAtom);
  const activeCloudOrg = useMemo(
    () => getSidebarActiveCloudOrg(activeCloudOrgId, cloudOrgs),
    [activeCloudOrgId, cloudOrgs]
  );

  // A scope switch while the dialog is open must not leave a hidden stale
  // editor that can reappear later under a different organization.
  useEffect(() => {
    if (session && !activeCloudOrg) onClose();
  }, [activeCloudOrg, onClose, session]);

  const modeLabels = useMemo(
    () => ({
      [COLLAB_SESSION_ACCESS_MODE.OFF]: t("cloud.syncLevel.modeOff"),
      [COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY]: t(
        "cloud.syncLevel.modeMetadata"
      ),
      [COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY]: t(
        "cloud.syncLevel.modeFullReplay"
      ),
    }),
    [t]
  );

  const handleModeChange = useCallback(
    (orgId: string, value: string | number | (string | number)[]) => {
      if (!session) return;
      setAccessByOrg((current) =>
        withCloudSessionMode(
          current,
          orgId,
          session.session_id,
          value === USE_ORG_MINIMUM ? null : (value as CollabSessionAccessMode)
        )
      );
      org2CloudSyncEngine.resumeOrg(orgId);
    },
    [session, setAccessByOrg]
  );

  const handleVisibilityChange = useCallback(
    (orgId: string, value: string | number | (string | number)[]) => {
      if (!session) return;
      setAccessByOrg((current) =>
        withCloudSessionVisibility(
          current,
          orgId,
          session.session_id,
          value as CollabSessionVisibility
        )
      );
      org2CloudSyncEngine.resumeOrg(orgId);
    },
    [session, setAccessByOrg]
  );

  const visibilityOptions = useMemo(
    () => [
      {
        value: COLLAB_SESSION_VISIBILITY.ORG,
        label: t("cloud.syncLevel.visibilityOrg"),
        dataTestId: "session-sync-level-visibility-option-org",
      },
      {
        value: COLLAB_SESSION_VISIBILITY.RESTRICTED,
        label: t("cloud.syncLevel.visibilityRestricted"),
        dataTestId: "session-sync-level-visibility-option-restricted",
      },
    ],
    [t]
  );

  return (
    <Modal
      visible={session !== null}
      title={t("cloud.syncLevel.title")}
      onCancel={onClose}
      footer={null}
      width={480}
    >
      {session ? (
        <div className="flex flex-col gap-3">
          <div className="text-[12px] text-text-3">
            {session.name || session.user_input || session.session_id}
          </div>
          <div className="text-[11px] text-text-3">
            {t("cloud.syncLevel.hint")}
          </div>
          {!activeCloudOrg ? (
            <div className="text-[12px] text-text-3">
              {t("cloud.moveToOrg.noOrgs")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {[activeCloudOrg].map((org) => {
                const settings = getCloudOrgAccessSettings(
                  accessByOrg,
                  org.orgId
                );
                const overrideMode =
                  settings.sessionModes[session.session_id] ?? null;
                const visibility =
                  settings.sessionVisibility[session.session_id] ??
                  COLLAB_SESSION_VISIBILITY.ORG;
                const tagged = isSessionTaggedToCloudOrg(
                  tags,
                  session.session_id,
                  org.orgId
                );
                // Admin sharing FLOOR (0002): drop every mode below the floor
                // from the picker so a member can't author a sub-floor value
                // (the engine + server floor it anyway). The sentinel follows
                // the single org policy: its minimum, or Off when unset.
                const floor = getOrgSharingFloor(floorByOrg, org.orgId);
                const modeOptions = [
                  {
                    value: USE_ORG_MINIMUM,
                    label: t("cloud.syncLevel.orgMinimumOption", {
                      mode: modeLabels[floor],
                    }),
                    dataTestId: `session-sync-level-mode-option-${org.orgId}-minimum`,
                  },
                  ...ACCESS_MODE_LADDER.filter((mode) =>
                    isAccessModeAtLeast(mode, floor)
                  ).map((mode) => ({
                    value: mode,
                    label: modeLabels[mode],
                    dataTestId: `session-sync-level-mode-option-${org.orgId}-${mode}`,
                  })),
                ];
                // A stale sub-floor override shows as its floored value (what
                // actually gets pushed), never a now-hidden option.
                const selectedMode = overrideMode
                  ? floorAccessMode(overrideMode, floor)
                  : USE_ORG_MINIMUM;
                return (
                  <div
                    key={org.orgId}
                    className="flex flex-col gap-2 rounded-lg border border-border-2 bg-bg-2 px-3 py-2"
                    data-testid={`session-sync-level-org-${org.orgId}`}
                  >
                    <span className="text-[13px] text-text-1">{org.name}</span>
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedMode}
                        options={modeOptions}
                        onChange={(value) => handleModeChange(org.orgId, value)}
                        size="small"
                        className="min-w-0 flex-1"
                        panelZIndex={MODAL_SELECT_Z_INDEX}
                        dataTestId={`session-sync-level-mode-${org.orgId}`}
                      />
                      <Select
                        value={visibility}
                        options={visibilityOptions}
                        onChange={(value) =>
                          handleVisibilityChange(org.orgId, value)
                        }
                        size="small"
                        className="min-w-0 flex-1"
                        panelZIndex={MODAL_SELECT_Z_INDEX}
                        dataTestId={`session-sync-level-visibility-${org.orgId}`}
                      />
                    </div>
                    {floor !== COLLAB_SESSION_ACCESS_MODE.OFF ? (
                      // Admin policy: this org mandates a minimum sharing level.
                      <span
                        className="text-[11px] text-warning-6"
                        data-testid={`session-sync-level-floor-note-${org.orgId}`}
                      >
                        {t("cloud.syncLevel.floorNote", {
                          mode: modeLabels[floor],
                        })}
                      </span>
                    ) : null}
                    {tagged ? (
                      // Tagged ("moved") sessions never drop below metadata:
                      // the engine floors effective-off to metadata_only so
                      // the explicit move isn't silently a no-op.
                      <span className="text-[11px] text-text-3">
                        {t("cloud.syncLevel.taggedNote")}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
};

export default CloudSyncLevelDialog;
