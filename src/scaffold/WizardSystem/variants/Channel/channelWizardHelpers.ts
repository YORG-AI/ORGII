import { parseCommaSeparated } from "@src/modules/MainApp/Integrations/Connections/Channels/utils";

export interface ChannelWizardErrors {
  type?: string;
  name?: string;
}

export function buildConfigData(
  channelConfig: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { enabled: true };

  for (const [key, value] of Object.entries(channelConfig)) {
    if (key === "allowFrom" && typeof value === "string") {
      result[key] = parseCommaSeparated(value);
    } else if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

export function normalizeAccountName(accountName: string): string {
  return accountName.trim().toLowerCase().replace(/\s+/g, "-");
}

export function nextDefaultName(
  baseName: string,
  existingNames: string[]
): string {
  const normalizedExistingNames = new Set(
    existingNames.map((name) => name.trim().toLowerCase())
  );
  if (!normalizedExistingNames.has(baseName.toLowerCase())) return baseName;

  let suffix = 1;
  while (normalizedExistingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

export function resolveAccountName(
  accountName: string,
  baseName: string,
  existingAccountIds: string[]
): string {
  const trimmedName = accountName.trim();
  if (trimmedName) return trimmedName;

  const normalizedExistingNames = existingAccountIds.map(normalizeAccountName);
  return nextDefaultName(baseName, normalizedExistingNames);
}

export function hasDuplicateAccountName(
  selectedType: string | null,
  normalizedAccountName: string,
  existingAccounts: Map<string, string[]>
): boolean {
  return (
    !!selectedType &&
    normalizedAccountName !== "" &&
    (existingAccounts.get(selectedType) ?? []).includes(normalizedAccountName)
  );
}

interface AccountNameValidationMessages {
  duplicate: string;
}

export function validateAccountName(
  isDuplicateName: boolean,
  messages: AccountNameValidationMessages
): ChannelWizardErrors {
  if (isDuplicateName) return { name: messages.duplicate };
  return {};
}
