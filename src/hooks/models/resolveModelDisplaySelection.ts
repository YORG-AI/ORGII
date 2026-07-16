import { isHostedKey } from "@src/api/tauri/session";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import { accountHasModel } from "@src/hooks/models/useModelAccountLookup";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import {
  parseModelVariant,
  resolveModelVariantFields,
} from "@src/util/modelVariants";

/**
 * Resolves the effective model id shown in chat input pills.
 *
 * For active own-key sessions whose stored model is a bare base model (no
 * user-chosen effort/variant), applies the selected account's persisted
 * default variant so the pill matches the model the next turn launches with.
 * When the session already carries a concrete variant (the effort the user
 * picked in the session creator, e.g. `gpt-5.5-high` or a claude-code effort),
 * that selection is authoritative and is kept as-is — otherwise the pill would
 * drift back to the account/seed default. Historical sessions keep the stored
 * model id unchanged.
 */
export function resolveModelDisplaySelection(
  selection: LastModelSelection | null | undefined,
  accounts: KeyVaultAccount[],
  isActiveSession: boolean
): LastModelSelection | null | undefined {
  if (!selection || isHostedKey(selection.keySource) || !selection.model) {
    return selection;
  }
  if (!isActiveSession) return selection;

  // The session's stored model already encodes a user-chosen variant/effort;
  // treat it as authoritative and do not overwrite it with the account default.
  if (parseModelVariant(selection.model)) return selection;

  const selectedAccount = accounts.find((account) => {
    if (selection.selectedAccountId) {
      return account.id === selection.selectedAccountId;
    }
    if (
      selection.selectedSourceModelType &&
      account.modelType !== selection.selectedSourceModelType
    ) {
      return false;
    }
    if (selection.selectedSourceLabel) {
      return account.name === selection.selectedSourceLabel;
    }
    return accountHasModel(account, selection.model ?? "");
  });
  if (!selectedAccount) return selection;

  const baseModel = resolveModelVariantFields(selection.model).base_model;
  const accountModelIds = (selectedAccount.availableModels ?? []).filter(
    (modelId) =>
      accountHasModel(selectedAccount, modelId) &&
      resolveModelVariantFields(modelId).base_model === baseModel
  );
  if (accountModelIds.length === 0) return selection;

  const persistedModel = (selectedAccount.defaultVariants ?? []).find(
    (variant) =>
      variant.base_model === baseModel &&
      accountModelIds.includes(variant.model)
  )?.model;
  const variantInfos = accountModelIds.map((modelId) =>
    resolveModelVariantFields(modelId)
  );
  const effectiveModel = resolveDefaultVariant(
    baseModel,
    variantInfos,
    persistedModel
  );
  if (!effectiveModel || effectiveModel === selection.model) return selection;

  return { ...selection, model: effectiveModel };
}
