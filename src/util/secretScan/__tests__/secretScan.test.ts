import { describe, expect, it } from "vitest";

import {
  maskSecret,
  scanForSecrets,
  shannonEntropy,
  validateCustomPattern,
  validateCustomPatterns,
} from "../index";

describe("scanForSecrets — structured provider tokens", () => {
  it("detects an OpenAI key", () => {
    const matches = scanForSecrets(
      "here is my key sk-abcdef1234567890ABCDEFghij please use it"
    );
    expect(matches.map((m) => m.type)).toContain("openai");
  });

  it("detects an Anthropic key as anthropic (not openai)", () => {
    const matches = scanForSecrets(
      "token sk-ant-api03-abcDEF1234567890abcDEF1234567890"
    );
    const types = matches.map((m) => m.type);
    expect(types).toContain("anthropic");
    expect(types).not.toContain("openai");
  });

  it("detects an AWS access key ID", () => {
    const matches = scanForSecrets("export id AKIA1234567890ABCDEF now");
    expect(matches.map((m) => m.type)).toContain("aws_akid");
  });

  it("detects a GitHub token", () => {
    const matches = scanForSecrets(
      "clone with ghp_1234567890abcdefghijklmnopqrstuvwx12"
    );
    expect(matches.map((m) => m.type)).toContain("github");
  });

  it("detects a private key block", () => {
    const matches = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    expect(matches.map((m) => m.type)).toContain("private_key");
  });

  it("detects credentials embedded in a URL", () => {
    const matches = scanForSecrets(
      "postgres://admin:s3cretPass@db.example.com"
    );
    expect(matches.map((m) => m.type)).toContain("url_credentials");
  });

  it("de-duplicates repeated hits of the same type", () => {
    const matches = scanForSecrets(
      "sk-aaaaaaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbbbbbb"
    );
    expect(matches.filter((m) => m.type === "openai")).toHaveLength(1);
  });
});

describe("scanForSecrets — assignment heuristic", () => {
  it("flags password=... assignments", () => {
    const matches = scanForSecrets("password=hunter2superSecret");
    expect(matches.map((m) => m.type)).toContain("assignment");
  });

  it("does not double-report when the value is a known key", () => {
    const matches = scanForSecrets("api_key=sk-abcdefghijklmnopqrstuvwxyz12");
    const types = matches.map((m) => m.type);
    expect(types).toContain("openai");
    expect(types).not.toContain("assignment");
  });
});

describe("scanForSecrets — false-positive resistance", () => {
  it("ignores plain prose", () => {
    expect(scanForSecrets("please refactor the login component")).toEqual([]);
  });

  it("ignores git SHA-1 hashes", () => {
    expect(
      scanForSecrets("fix landed in 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b")
    ).toEqual([]);
  });

  it("ignores UUIDs", () => {
    expect(scanForSecrets("id 550e8400-e29b-41d4-a716-446655440000")).toEqual(
      []
    );
  });

  it("ignores documentation placeholders", () => {
    expect(scanForSecrets("set api_key=your_api_key_here")).toEqual([]);
    expect(scanForSecrets("AKIAIOSFODNN7EXAMPLE")).toEqual([]);
  });
});

describe("scanForSecrets — entropy tier (opt-in)", () => {
  const highEntropy = "prompt with kJ8xQ2mZ9pL4vB7nR1tW3yE6aH0cF5dG token";

  it("does not flag high-entropy strings by default", () => {
    expect(scanForSecrets(highEntropy)).toEqual([]);
  });

  it("flags high-entropy strings when enabled", () => {
    const matches = scanForSecrets(highEntropy, { entropy: true });
    expect(matches.map((m) => m.type)).toContain("entropy");
  });

  it("still ignores prose when entropy is on", () => {
    expect(
      scanForSecrets("please update the readme and the changelog", {
        entropy: true,
      })
    ).toEqual([]);
  });
});

describe("scanForSecrets — custom patterns", () => {
  it("matches a user-supplied pattern", () => {
    const matches = scanForSecrets("token MYCORP_ABCDEFGHIJKLMNOPQRST", {
      customPatterns: ["MYCORP_[A-Z0-9]{20}"],
    });
    expect(matches.map((m) => m.type)).toContain("custom:0");
  });

  it("ignores invalid custom patterns without throwing", () => {
    expect(() =>
      scanForSecrets("anything", { customPatterns: ["[unclosed"] })
    ).not.toThrow();
  });
});

describe("maskSecret", () => {
  it("masks short values entirely", () => {
    expect(maskSecret("abc")).toBe("•••");
  });

  it("keeps a prefix and suffix for long values", () => {
    expect(maskSecret("sk-abcdefghijklmnop")).toBe("sk-…mnop");
  });
});

describe("validateCustomPattern(s)", () => {
  it("returns null for a valid pattern", () => {
    expect(validateCustomPattern("[A-Z]{4}")).toBeNull();
  });

  it("returns an error for an invalid pattern", () => {
    expect(validateCustomPattern("[unclosed")).not.toBeNull();
  });

  it("collects only the invalid patterns", () => {
    const invalid = validateCustomPatterns(["[A-Z]+", "(", "\\d{3}"]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].pattern).toBe("(");
  });
});

describe("shannonEntropy", () => {
  it("is 0 for a single repeated character", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
  });

  it("is higher for mixed content", () => {
    expect(shannonEntropy("aB3xZ9")).toBeGreaterThan(2);
  });
});
