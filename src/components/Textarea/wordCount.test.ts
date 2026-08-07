import { countWords } from "./wordCount";

describe("countWords", () => {
  it("counts words across whitespace and punctuation", () => {
    expect(
      countWords("Write commits in English.\nInclude a detailed body")
    ).toBe(8);
  });

  it("returns zero for empty whitespace", () => {
    expect(countWords("  \n\t ")).toBe(0);
  });

  it("segments languages that do not separate every word with spaces", () => {
    expect(countWords("使用中文撰寫提交訊息")).toBe(5);
  });
});
