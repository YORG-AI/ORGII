import React from "react";

import { formatModelAgentType, isApiKeyProvider } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

export function getAccountSourceBreadcrumbParent(modelType: string): string {
  const brand = formatModelAgentType(modelType);
  if (isApiKeyProvider(modelType)) {
    return `${brand} API`;
  }
  return brand;
}

interface AccountSourceBreadcrumbProps {
  modelType: string;
  accountName: string;
}

export const AccountSourceBreadcrumb: React.FC<
  AccountSourceBreadcrumbProps
> = ({ modelType, accountName }) => {
  const parent = getAccountSourceBreadcrumbParent(modelType);

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ModelIcon agentType={modelType} size="small" className="shrink-0" />
      <span className="flex min-w-0 items-center gap-1 text-xs">
        <span className="shrink-0 text-text-2">{parent}</span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          data-icon="chevron-right"
          size={12}
          className="shrink-0 text-text-4"
          aria-hidden
        />
        <span className="min-w-0 truncate font-medium text-text-1">
          {accountName}
        </span>
      </span>
    </span>
  );
};
