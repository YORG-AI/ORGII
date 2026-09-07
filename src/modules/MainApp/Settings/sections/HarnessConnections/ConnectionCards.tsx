import React from "react";
import { useTranslation } from "react-i18next";

import type { HarnessConnectionView } from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";

export default function ConnectionCards({
  choices,
  selected,
  active,
  disabled,
  onSelect,
  onAdd,
}: {
  choices: HarnessConnectionView["choices"];
  selected: string;
  active: string | null;
  disabled: boolean;
  onSelect: (keyId: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div
      className="flex w-full flex-col gap-2"
      role="group"
      aria-label={t("harnessConnections.connection")}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {choices.map((choice) => (
          <Button
            key={choice.keyId}
            variant={selected === choice.keyId ? "primary" : "secondary"}
            appearance="outline"
            disabled={disabled}
            aria-pressed={selected === choice.keyId}
            onClick={() => onSelect(choice.keyId)}
            className="h-auto min-w-0 justify-start py-3 text-left whitespace-normal"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="font-medium break-words">
                {choice.name}
                {active === choice.keyId && (
                  <span className="ml-2 text-xs text-success-6">
                    {t("harnessConnections.current")}
                  </span>
                )}
              </span>
              {choice.endpoint && (
                <span className="text-xs break-all text-text-3">
                  {choice.endpoint}
                </span>
              )}
            </span>
          </Button>
        ))}
      </div>
      <div>
        <Button variant="secondary" disabled={disabled} onClick={onAdd}>
          {t("harnessConnections.add")}
        </Button>
      </div>
    </div>
  );
}
