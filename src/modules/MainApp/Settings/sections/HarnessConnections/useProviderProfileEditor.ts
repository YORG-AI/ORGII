import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type {
  HarnessConnectionView,
  HarnessProviderProfile,
} from "@src/api/tauri/rpc/schemas/agentOrgs";

import {
  refreshHarnessConnections,
  useHarnessConnection,
} from "./useHarnessConnection";

type Target = HarnessProviderProfile["target"];
type Action = "save" | "test" | "apply" | "restore" | "delete" | "fetch";
export function newProviderProfile(
  target: Target,
  name: string,
  view: HarnessConnectionView | null,
  copy = false
): HarnessProviderProfile {
  if (copy && view?.appliedProfile?.target === target)
    return {
      ...view.appliedProfile,
      id: crypto.randomUUID(),
      revision: 0,
      name,
    };
  const choice = copy
    ? view?.choices.find((c) => c.keyId === view.config.selectedKeyId)
    : view?.choices.find((c) => !c.reason);
  const model =
    (copy ? view?.config.selectedModel : null) ?? choice?.models[0] ?? "";
  const entry = { model, displayName: "", context1m: false };
  const endpoint =
    (copy ? view?.desktopOptions?.endpoint : null) ?? choice?.endpoint ?? "";
  const common = {
    id: crypto.randomUUID(),
    revision: 0,
    name,
    target,
    keyId: choice?.keyId ?? "",
    endpoint,
  };
  if (target === "codex")
    return {
      ...common,
      target,
      authScheme: "bearer",
      models: {
        model,
        reasoningEffort: null,
        contextWindow: null,
        autoCompactTokenLimit: null,
      },
    };
  return {
    ...common,
    target,
    authScheme:
      (copy ? view?.desktopOptions?.authScheme : null) ??
      (endpoint === "https://api.anthropic.com" ? "x-api-key" : "bearer"),
    models: {
      defaultRole: "sonnet",
      roles: {
        sonnet: { ...entry },
        opus: { ...entry },
        fable: { ...entry },
        haiku: { ...entry },
      },
    },
  };
}
export function useProviderProfileEditor(target: Target) {
  const { t } = useTranslation("settings");
  const { view, loading, error, reload } = useHarnessConnection(target);
  const [draft, setDraft] = useState<HarnessProviderProfile | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const generation = useRef(0);
  const request = useRef<string | null>(null);
  const cancel = () => {
    generation.current++;
    if (request.current)
      void rpc.agentOrgs.connections
        .cancelTest({ requestId: request.current })
        .catch(() => undefined);
    request.current = null;
    setBusy(null);
    setReceipt(null);
  };
  useEffect(
    () => () => {
      generation.current++;
      if (request.current)
        void rpc.agentOrgs.connections
          .cancelTest({ requestId: request.current })
          .catch(() => undefined);
    },
    []
  );
  const edit = (profile: HarnessProviderProfile | null) => {
    generation.current++;
    setReceipt(null);
    setMessage(null);
    if (
      profile?.keyId !== draft?.keyId ||
      profile?.endpoint !== draft?.endpoint ||
      profile?.authScheme !== draft?.authScheme
    )
      setModels([]);
    setDraft(profile);
  };
  const saved = view?.profiles?.find((p) => p.id === draft?.id);
  const dirty = Boolean(
    draft && JSON.stringify(draft) !== JSON.stringify(saved)
  );
  const act = async (action: Action) => {
    if (!draft && action !== "restore") return;
    const current = ++generation.current;
    setBusy(action);
    setMessage(null);
    try {
      if (action === "restore") {
        await rpc.agentOrgs.managedConfig.restoreDefault({
          agentName: target,
          force: false,
        });
      } else if (draft) {
        const selection = {
          agentName: target,
          keyId: draft.keyId,
          model: profileDefaultModel(draft),
          profile: draft,
        };
        if (action === "save") {
          const result = await rpc.agentOrgs.connections.saveProfile({
            profile: draft,
          });
          if (current !== generation.current) return;
          setDraft(result);
          setReceipt(null);
        } else if (action === "delete") {
          await rpc.agentOrgs.connections.deleteProfile({
            agentName: target,
            id: draft.id,
            revision: draft.revision,
          });
          if (current !== generation.current) return;
          setDraft(null);
          setReceipt(null);
        } else if (action === "test" || action === "fetch") {
          const requestId = crypto.randomUUID();
          request.current = requestId;
          if (action === "test") {
            const token = await rpc.agentOrgs.connections.test({
              ...selection,
              requestId,
            });
            if (current !== generation.current) return;
            setReceipt(token);
          } else {
            const result = await rpc.agentOrgs.connections.fetchModels({
              agentName: target,
              keyId: draft.keyId,
              endpoint: draft.endpoint,
              authScheme: draft.authScheme,
              requestId,
            });
            if (current !== generation.current) return;
            setModels(result);
          }
        } else if (action === "apply") {
          await rpc.agentOrgs.connections.apply({
            ...selection,
            routing: "direct",
            receipt,
            expectedHashes: Object.fromEntries(
              (view?.config.targetFiles ?? []).map((f) => [
                f.id,
                f.currentHash ?? null,
              ])
            ),
          });
          if (current !== generation.current) return;
          setReceipt(null);
        }
      }
      if (current !== generation.current) return;
      setMessage(
        t(
          action === "apply"
            ? target === "claude_desktop"
              ? "harnessConnections.desktopApplied"
              : "harnessConnections.applied"
            : action === "restore"
              ? target === "claude_desktop"
                ? "harnessConnections.desktopRestored"
                : "harnessConnections.restored"
              : `claudeProfiles.${action}Done`
        )
      );
      if (action !== "fetch" && action !== "test") refreshHarnessConnections();
    } catch (error) {
      if (current === generation.current) {
        setMessage(String(error));
        if (action === "test" || action === "apply") setReceipt(null);
      }
    } finally {
      if (current === generation.current) {
        setBusy(null);
        request.current = null;
      }
    }
  };
  return {
    view,
    loading,
    error,
    reload,
    draft,
    edit,
    busy,
    message,
    receipt,
    models,
    dirty,
    saved,
    act,
    cancel,
  };
}

export function profileDefaultModel(profile: HarnessProviderProfile): string {
  return profile.target === "codex"
    ? profile.models.model
    : profile.models.roles[profile.models.defaultRole].model;
}
