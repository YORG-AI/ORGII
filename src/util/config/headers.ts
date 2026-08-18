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

export function getGlobalSSEHeaders(): Record<string, string> {
  const _selectedItem =
    (localStorage.getItem("selectedParentItem") as LLMType) || LLMType.DEEPSEEK;
  return {
    "Content-Type": "application/json",
    "X-key-type": getKeyTypeFromSelectedParentItem(),
    "X-llm-type": getLLMTypeFromSelectedItem(),
  };
}
export function getGlobalCommonHeaders(): Record<string, string> {
  const _selectedItem =
    (localStorage.getItem("selectedParentItem") as LLMType) || LLMType.DEEPSEEK;
  return {
    "X-key-type": getKeyTypeFromSelectedParentItem(),
    "X-llM-type": getLLMTypeFromSelectedItem(),
  };
}
export function getImageCommonHeaders(): Record<string, string> {
  return {
    responseType: "blob",
    "X-key-type": getKeyTypeFromSelectedParentItem(),
    "X-llM-type": getLLMTypeFromSelectedItem(),
  };
}
