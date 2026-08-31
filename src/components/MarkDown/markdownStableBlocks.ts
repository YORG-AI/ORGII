/**
 * markdownStableBlocks
 *
 * Splits streaming markdown into blocks that stop changing once complete, so
 * only the trailing block is reparsed as new tokens arrive. Blank-line
 * boundaries inside a fenced code block are ignored — a fence stays one block
 * until its closing run of backticks (or the end of the stream).
 */
export function splitIntoStableMarkdownBlocks(content: string): string[] {
  if (!content) return [""];

  const blocks: string[] = [];
  let blockStart = 0;
  let fenceLength = 0;
  let index = 0;

  while (index < content.length) {
    if (content[index] === "`") {
      const fenceMatch = /^`{3,}/.exec(content.slice(index));
      if (fenceMatch) {
        const currentFenceLength = fenceMatch[0].length;
        if (fenceLength === 0) {
          fenceLength = currentFenceLength;
        } else if (currentFenceLength >= fenceLength) {
          fenceLength = 0;
        }
        index += currentFenceLength;
        continue;
      }
    }

    if (
      fenceLength === 0 &&
      content[index] === "\n" &&
      index + 1 < content.length &&
      content[index + 1] === "\n"
    ) {
      const block = content.slice(blockStart, index + 2);
      if (block.trim()) blocks.push(block);
      blockStart = index + 2;
      index = blockStart;
      continue;
    }

    index += 1;
  }

  blocks.push(content.slice(blockStart));
  return blocks;
}
