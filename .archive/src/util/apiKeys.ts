/**
 * API Key Utilities
 *
 * Centralized access to API keys used across the application.
 * Currently provides OpenAI API key access (used by voice input / Whisper).
 */

let cachedOpenAIKey: string | null = null;

/**
 * Get the OpenAI API key for direct API calls (e.g., Whisper transcription).
 * @returns API key string or null if not configured
 */
export function getOpenAIApiKey(): string | null {
  if (cachedOpenAIKey) {
    return cachedOpenAIKey;
  }

  // Try Vite env
  const viteKey = (
    import.meta as unknown as {
      env?: Record<string, string | undefined>;
    }
  ).env?.VITE_OPENAI_API_KEY;

  if (viteKey && viteKey.startsWith("sk-")) {
    cachedOpenAIKey = viteKey;
    return cachedOpenAIKey;
  }

  return null;
}

/**
 * Set OpenAI API key programmatically (from user settings).
 */
export function setOpenAIApiKey(apiKey: string | undefined | null): void {
  if (!apiKey) {
    cachedOpenAIKey = null;
    return;
  }
  if (apiKey.startsWith("sk-")) {
    cachedOpenAIKey = apiKey;
  }
}
