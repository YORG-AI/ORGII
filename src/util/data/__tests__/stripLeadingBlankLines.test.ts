import { describe, expect, it } from "vitest";

import { stripLeadingBlankLines } from "../stripLeadingBlankLines";

describe("stripLeadingBlankLines", () => {
  it.each([
    ["\nhello", "hello"],
    ["\n \t\n\nhello", "hello"],
    ["\r\n \t\r\nhello", "hello"],
    ["\r \t\rhello", "hello"],
    ["\u00a0\n\ufeff\nhello", "hello"],
    ["\n\n    code\n\n  next\n\n", "    code\n\n  next\n\n"],
    ["\n\thello\r\n\r\nworld\r\n", "\thello\r\n\r\nworld\r\n"],
    ["    code\n\n  next\n", "    code\n\n  next\n"],
    ["", ""],
    [" \t", ""],
    ["\n \t\r\n \t", ""],
  ])("normalizes %j to %j", (text, expected) => {
    expect(stripLeadingBlankLines(text)).toBe(expected);
    expect(stripLeadingBlankLines(expected)).toBe(expected);
  });
});
