import { describe, expect, it } from "vitest";

import { normalizeHttpUrlCandidate } from "./validation";

describe("normalizeHttpUrlCandidate", () => {
  it("normalizes valid HTTP and HTTPS URLs", () => {
    expect(normalizeHttpUrlCandidate("http://localhost:1998")).toBe(
      "http://localhost:1998/"
    );
    expect(normalizeHttpUrlCandidate("https://example.com/docs")).toBe(
      "https://example.com/docs"
    );
  });

  it("keeps local, IP, IPv6, and internal development hosts", () => {
    expect(normalizeHttpUrlCandidate("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000/"
    );
    expect(normalizeHttpUrlCandidate("http://[::1]:5173")).toBe(
      "http://[::1]:5173/"
    );
    expect(normalizeHttpUrlCandidate("http://myservice:8080/health")).toBe(
      "http://myservice:8080/health"
    );
    expect(normalizeHttpUrlCandidate("http://foo_bar.local/path")).toBe(
      "http://foo_bar.local/path"
    );
  });

  it("allows placeholder-like characters in paths and queries", () => {
    expect(
      normalizeHttpUrlCandidate("https://example.com/${path}?q={value}")
    ).toBe("https://example.com/$%7Bpath%7D?q={value}");
  });

  it("rejects non-HTTP schemes and template placeholder hosts", () => {
    expect(normalizeHttpUrlCandidate("file:///tmp/app.log")).toBeNull();
    expect(normalizeHttpUrlCandidate("http://${host}/")).toBeNull();
    expect(normalizeHttpUrlCandidate("http://${host}:${port}")).toBeNull();
    expect(normalizeHttpUrlCandidate("http://$HOST:1998")).toBeNull();
    expect(normalizeHttpUrlCandidate("http://{{host}}/")).toBeNull();
    expect(normalizeHttpUrlCandidate("http://<host>/")).toBeNull();
  });

  it("rejects malformed or unsafe authorities", () => {
    expect(normalizeHttpUrlCandidate("https://example.com other")).toBeNull();
    expect(normalizeHttpUrlCandidate("https://exa mple.com")).toBeNull();
    expect(normalizeHttpUrlCandidate("http://example.com:99999")).toBeNull();
    expect(normalizeHttpUrlCandidate("http:///missing-host")).toBeNull();
  });
});
