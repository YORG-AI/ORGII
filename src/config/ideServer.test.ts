import { afterEach, describe, expect, it } from "vitest";

import {
  IDE_SERVER_HTTP_URL,
  IDE_SERVER_PORT,
  IDE_SERVER_WS_URL,
  configureIdeServerForIdentifier,
} from "./ideServer";

afterEach(() => {
  configureIdeServerForIdentifier("org2ai.org2");
});

describe("configureIdeServerForIdentifier", () => {
  it("switches every local transport URL to the isolated backend", () => {
    expect(configureIdeServerForIdentifier("org2ai.org2.instance2")).toBe(
      13_848
    );
    expect(IDE_SERVER_PORT).toBe("13848");
    expect(IDE_SERVER_HTTP_URL).toBe("http://localhost:13848");
    expect(IDE_SERVER_WS_URL).toBe("ws://localhost:13848/ws");
  });
});
