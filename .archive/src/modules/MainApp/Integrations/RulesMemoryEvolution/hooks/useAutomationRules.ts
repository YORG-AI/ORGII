/**
 * useAutomationRules — CRUD operations for automation rules via Tauri invoke.
 */
import { useCallback, useRef, useState } from "react";

import {
  addAutomationRule,
  getAutomationStatus,
  listAutomationRules,
  removeAutomationRule,
  updateAutomationRule,
} from "@src/api/tauri/agent";
import { createLogger } from "@src/hooks/logger";
import type { ActionInstance } from "@src/modules/MainApp/AgentOrgs/data";

import type { AutomationRule, AutomationStatus } from "../types";

const log = createLogger("AutomationRules");

const DEFAULT_STATUS: AutomationStatus = {
  running: false,
  activeRules: 0,
  totalRules: 0,
  totalFires: 0,
  uptimeSecs: 0,
  agentAlive: false,
  messagesProcessed: 0,
  lastHealthCheck: "",
};

type WorkflowActionWire = {
  type: "workflow";
  actions: ActionInstance[];
};

type AutomationActionWire = WorkflowActionWire | Record<string, unknown>;

type AutomationRuleWire = Omit<AutomationRule, "actions"> & {
  action: AutomationActionWire;
  actions?: ActionInstance[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isActionInstance(value: unknown): value is ActionInstance {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.definitionId === "string" &&
    isRecord(value.data)
  );
}

function singleActionToInstance(
  ruleId: string,
  action: Record<string, unknown>
): ActionInstance | null {
  const actionType = stringValue(action.type);
  switch (actionType) {
    case "injectPrompt":
      return {
        id: `${ruleId}-action`,
        definitionId: "inject-prompt",
        data: {
          0: stringValue(action.prompt) ?? "",
          1: stringValue(action.sessionId) ?? null,
        },
      };
    case "startSession":
      return {
        id: `${ruleId}-action`,
        definitionId: "start-session",
        data: {
          prompt: stringValue(action.prompt) ?? "",
          agentType: stringValue(action.agentType) ?? "default",
          model: stringValue(action.model) ?? undefined,
          repoPath: stringValue(action.repoPath) ?? undefined,
        },
      };
    case "killSession":
      return {
        id: `${ruleId}-action`,
        definitionId: "kill-session",
        data: { 0: stringValue(action.sessionId) ?? null },
      };
    case "sendMessage":
      return {
        id: `${ruleId}-action`,
        definitionId: "send-message",
        data: {
          0: stringValue(action.channel) ?? "",
          1: stringValue(action.content) ?? "",
        },
      };
    case "injectToSession":
      return {
        id: `${ruleId}-action`,
        definitionId: "inject-to-session",
        data: {
          0: stringValue(action.sessionId) ?? null,
          1: stringValue(action.message) ?? "",
        },
      };
    default:
      return null;
  }
}

function actionsFromWireRule(rule: AutomationRuleWire): ActionInstance[] {
  if (rule.actions) return rule.actions;
  const action = rule.action;
  if (isRecord(action) && action.type === "workflow") {
    return Array.isArray(action.actions)
      ? action.actions.filter(isActionInstance)
      : [];
  }
  if (isRecord(action)) {
    const instance = singleActionToInstance(rule.id, action);
    return instance ? [instance] : [];
  }
  return [];
}

function fromWireRule(rule: AutomationRuleWire): AutomationRule {
  return {
    ...rule,
    actions: actionsFromWireRule(rule),
  };
}

function toWireRule(rule: AutomationRule): AutomationRuleWire {
  const { actions, ...rest } = rule;
  return {
    ...rest,
    action: {
      type: "workflow",
      actions,
    },
  };
}

export function useAutomationRules() {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<AutomationStatus>(DEFAULT_STATUS);
  /** Only the latest overlapping `refresh` may clear loading (avoids stale clears while an older request is still running). */
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const result = await listAutomationRules();
      if (seq !== refreshSeqRef.current) return;
      setRules((result as unknown as AutomationRuleWire[]).map(fromWireRule));

      const statusResult = await getAutomationStatus();
      if (seq !== refreshSeqRef.current) return;
      setStatus(statusResult);
    } catch (error) {
      log.error("[AutomationRules] Failed to fetch rules:", error);
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, []);

  const addRule = useCallback(
    async (rule: AutomationRule) => {
      setLoading(true);
      try {
        await addAutomationRule(
          toWireRule(rule) as unknown as Parameters<typeof addAutomationRule>[0]
        );
        await refresh();
      } catch (error) {
        log.error("[AutomationRules] Failed to add rule:", error);
        setLoading(false);
        throw error;
      }
    },
    [refresh]
  );

  const updateRule = useCallback(
    async (rule: AutomationRule) => {
      setLoading(true);
      try {
        await updateAutomationRule(
          toWireRule(rule) as unknown as Parameters<
            typeof updateAutomationRule
          >[0]
        );
        await refresh();
      } catch (error) {
        log.error("[AutomationRules] Failed to update rule:", error);
        setLoading(false);
        throw error;
      }
    },
    [refresh]
  );

  const removeRule = useCallback(
    async (ruleId: string) => {
      setLoading(true);
      try {
        await removeAutomationRule(ruleId);
        await refresh();
      } catch (error) {
        log.error("[AutomationRules] Failed to remove rule:", error);
        setLoading(false);
        throw error;
      }
    },
    [refresh]
  );

  const toggleRule = useCallback(
    async (ruleId: string) => {
      const existingRule = rules.find((rule) => rule.id === ruleId);
      if (!existingRule) return;
      await updateRule({ ...existingRule, enabled: !existingRule.enabled });
    },
    [rules, updateRule]
  );

  return {
    rules,
    status,
    loading,
    refresh,
    addRule,
    updateRule,
    removeRule,
    toggleRule,
  };
}
