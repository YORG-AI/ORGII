import { describe, expect, it } from "vitest";

import {
  requiresCodexReauthentication,
  sanitizeAgentErrorMessage,
} from "../sanitizeAgentErrorMessage";

const HTML_500 = `<!doctype html>
<html lang=en>
<title>500 Internal Server Error</title>
<h1>Internal Server Error</h1>
<p>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</p>`;

describe("sanitizeAgentErrorMessage", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeAgentErrorMessage("")).toBe("");
  });

  it("strips a leading 'Error:' prefix", () => {
    expect(sanitizeAgentErrorMessage("Error: something broke")).toBe(
      "something broke"
    );
  });

  it("collapses a raw HTML 500 page into a concise message with prefix", () => {
    const raw = `LLM error: Request failed: HTTP 500: ${HTML_500}`;
    expect(sanitizeAgentErrorMessage(raw)).toBe(
      "LLM error: Request failed: HTTP 500 Internal Server Error"
    );
  });

  it("handles an HTML body with no surrounding prose", () => {
    expect(sanitizeAgentErrorMessage(HTML_500)).toBe(
      "500 Internal Server Error"
    );
  });

  it("uses the <title> when the status code has no known reason phrase", () => {
    const raw =
      "Request failed: HTTP 599: <html><head><title>Edge Gateway Down</title></head></html>";
    expect(sanitizeAgentErrorMessage(raw)).toBe(
      "Request failed: HTTP 599 Edge Gateway Down"
    );
  });

  it("falls back to a generic summary when HTML has neither status nor title", () => {
    expect(
      sanitizeAgentErrorMessage("<html><body><h1>broken</h1></body></html>")
    ).toBe("Server error");
  });

  it("leaves a plain JSON-ish error message untouched", () => {
    const raw = 'Request failed: HTTP 400: {"error":{"message":"bad model"}}';
    expect(sanitizeAgentErrorMessage(raw)).toBe(raw);
  });

  it("collapses excessive blank lines in plain messages", () => {
    expect(sanitizeAgentErrorMessage("line one\n\n\n\nline two")).toBe(
      "line one\n\nline two"
    );
  });

  it("truncates very long messages with an ellipsis", () => {
    const raw = "x".repeat(2000);
    const result = sanitizeAgentErrorMessage(raw);
    expect(result.length).toBe(600);
    expect(result.endsWith("…")).toBe(true);
  });

  it("trims trailing whitespace from plain messages", () => {
    expect(sanitizeAgentErrorMessage("   padded message   ")).toBe(
      "padded message"
    );
  });
});

describe("requiresCodexReauthentication", () => {
  it("recognizes a reused Codex OAuth refresh token", () => {
    const raw =
      '[session_launch] Failed to create LLM provider: Auth error: Codex OAuth refresh failed with HTTP 401 Unauthorized: {"code":"refresh_token_reused","message":"Your refresh token has already been used to generate a new access token. Please try signing in again."}';

    expect(requiresCodexReauthentication(raw)).toBe(true);
  });

  it("recognizes a Codex invalid_grant response", () => {
    expect(
      requiresCodexReauthentication(
        "Codex OAuth refresh failed: invalid_grant; try signing in again"
      )
    ).toBe(true);
  });

  it("does not turn a generic 401 into a Codex login prompt", () => {
    expect(
      requiresCodexReauthentication("HTTP 401 Unauthorized: invalid API key")
    ).toBe(false);
  });
});
