/**
 * JoinCloudOrgDialog — consumer side of the `orgii://cloud/join` invite deep
 * link (modeled on `CollabShareImportDialog`): confirmation dialog →
 * `accept_invite(sha256(code))` → refresh `org2CloudOrgsAtom` → toast.
 *
 * The pending atom itself is the dialog state: it stays set while the
 * confirmation is open and is consumed (cleared) exactly once on dismiss or
 * successful join. Signed-out users get a sign-in CTA that routes to the
 * Settings sign-in card; the pending invite SURVIVES that detour — when the
 * user returns to the Workstation surface, the dialog re-opens with the
 * same code (in-memory only, so an app restart drops it).
 *
 * The plaintext code never leaves this device: only its sha256 goes to
 * `accept_invite` (same code model as invite creation).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { buildSettingsPath } from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { acceptCloudInvite } from "./org2CloudManagementClient";
import { cloudManagementErrorMessage } from "./org2CloudOrgManagement";
import { useRefetchOrg2CloudOrgs } from "./org2CloudOrgsAtom";
import { org2CloudPendingInviteAtom } from "./org2CloudPendingInviteAtom";
import { ensureProjectOrgForCloudOrg } from "./org2CloudProjectOrgAlias";

const JoinCloudOrgDialog: React.FC = () => {
  const { t } = useTranslation("navigation");
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useAtom(org2CloudPendingInviteAtom);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const refetchOrgs = useRefetchOrg2CloudOrgs();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = Boolean(auth);
  const codeSuffix = pending?.inviteCode.slice(-4) ?? "";
  // SidebarSelector keeps every sidebar (and this dialog) mounted across
  // routes, so gate visibility on the Workstation surface — NOT the pending
  // atom alone. The sign-in CTA detours to the Settings sign-in card; hiding
  // here (while `pending` survives) keeps the modal from covering it, then
  // re-opens the dialog once the user is back on the Workstation.
  const onWorkstation = location.pathname.startsWith(
    ROUTES.workStation.base.path
  );

  const handleClose = useCallback(() => {
    // One-shot consume: clears the atom so nothing can replay this link.
    setPending(null);
    setError(null);
  }, [setPending]);

  // Sign-in detour: keep the pending invite so the dialog re-opens once the
  // user is back on the Workstation surface after signing in.
  const handleOpenSettings = useCallback(() => {
    navigate(buildSettingsPath({ section: "collaboration" }));
  }, [navigate]);

  const handleJoin = useCallback(async () => {
    if (!pending || joining) return;
    const current = auth;
    if (!current) return;
    setJoining(true);
    setError(null);
    try {
      const fresh = await ensureFreshSession(current);
      if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
      commitRefreshedAuth(setAuth, current, fresh);
      const result = await acceptCloudInvite(
        fresh.accessToken,
        pending.inviteCode
      );
      const orgs = await refetchOrgs({
        until: (items) => items.some((org) => org.orgId === result.orgId),
      });
      const joinedOrg = orgs.find((org) => org.orgId === result.orgId);
      if (joinedOrg) {
        // Project-org alias on join (cloud-parity Phase B); best-effort —
        // the sync engine re-ensures it once per start.
        try {
          await ensureProjectOrgForCloudOrg(joinedOrg);
        } catch {
          // Non-fatal: the engine's per-org pass self-heals the alias.
        }
      }
      Message.success(
        joinedOrg
          ? t("cloud.orgManagement.join.joinedToast", { org: joinedOrg.name })
          : t("cloud.orgManagement.join.joinedFallbackToast")
      );
      setPending(null);
    } catch (caught) {
      setError(cloudManagementErrorMessage(caught, t));
    } finally {
      setJoining(false);
    }
  }, [auth, joining, pending, refetchOrgs, setAuth, setPending, t]);

  return (
    <Modal
      visible={pending !== null && onWorkstation}
      title={t("cloud.orgManagement.join.dialogTitle")}
      onCancel={handleClose}
      footer={null}
      width={440}
    >
      <div className="flex flex-col gap-3" data-testid="cloud-join-org-dialog">
        <div className="text-[12px] text-text-2">
          {t("cloud.orgManagement.join.prompt")}
        </div>

        <div className="rounded-xl border border-border-2 bg-bg-2 px-3 py-3">
          <div className="font-mono text-[13px] text-text-1">
            {t("cloud.orgManagement.join.codeSuffix", { suffix: codeSuffix })}
          </div>
        </div>

        {!signedIn ? (
          <div className="rounded-lg bg-fill-1 px-3 py-2 text-[12px] text-text-3">
            {t("cloud.orgManagement.join.signInFirst")}
          </div>
        ) : null}

        {error ? (
          <div
            className="rounded-lg bg-danger-1 px-3 py-2 text-[12px] text-danger-6"
            data-testid="cloud-join-org-error"
          >
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button htmlType="button" variant="secondary" onClick={handleClose}>
            {t("cloud.orgManagement.join.cancel")}
          </Button>
          {signedIn ? (
            <Button
              htmlType="button"
              variant="primary"
              loading={joining}
              disabled={joining || !pending}
              onClick={() => void handleJoin()}
              data-testid="cloud-join-org-confirm"
            >
              {t("cloud.orgManagement.join.confirm")}
            </Button>
          ) : (
            <Button
              htmlType="button"
              variant="primary"
              onClick={handleOpenSettings}
              data-testid="cloud-join-org-sign-in"
            >
              {t("cloud.orgManagement.join.openSettings")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default JoinCloudOrgDialog;
