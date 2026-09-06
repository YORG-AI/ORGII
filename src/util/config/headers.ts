import { SERVICE_AUTH_STORAGE_KEYS } from "@src/config/serviceAuth";

enum LLMType {
  DEEPSEEK = "deepseek",
  OPENAI = "openai",
}
enum KeyType {
  atlas = "atlas",
  on_prem = "on_prem",
}

export const getLLMTypeFromSelectedItem = (): LLMType => {
  const selectedItem = localStorage.getItem("selectedParentItem");
  switch (selectedItem) {
    case "GPT4o":
      return LLMType.OPENAI;
    case "Claude-3.5":
      return LLMType.OPENAI;
    case "Llama3":
      return LLMType.OPENAI;
    default:
      return LLMType.DEEPSEEK;
  }
};

export const getKeyTypeFromSelectedParentItem = (): KeyType => {
  const selectedParentItem = localStorage.getItem("selectedItem");
  return selectedParentItem === "AtlasKey" ? KeyType.atlas : KeyType.on_prem;
};

// Synchronous fallback Bearer source for legacy `main`/`agent` axios paths.
// Hosted-service requests override this in requestHandler with a fresh,
// auto-refreshing token via getOrRefreshHostedToken; non-hosted axios calls
// only have this localStorage value as a hint. We deliberately do NOT keep
// id_token in localStorage anymore — token storage of record lives in the
// Rust auth-tokens file (0o600); this getter just exposes the same value
// the hosted-service helpers already cache.
function readBearerHint(): string | null {
  return localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.accessToken);
}

export function getGlobalCommonHeaders(): Record<string, string> {
  const _selectedItem =
    (localStorage.getItem("selectedParentItem") as LLMType) || LLMType.DEEPSEEK;
  const bearer = readBearerHint();
  return {
    ...(bearer && {
      Authorization: `Bearer ${bearer}`,
    }),
    "X-key-type": getKeyTypeFromSelectedParentItem(),
    "X-llM-type": getLLMTypeFromSelectedItem(),
  };
}
