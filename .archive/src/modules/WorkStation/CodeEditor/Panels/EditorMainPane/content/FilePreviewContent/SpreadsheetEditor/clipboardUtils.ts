import type { CellRange, SpreadsheetData } from "./types";

export function stringifyRangeAsTsv(
  data: SpreadsheetData,
  range: CellRange
): string {
  return Array.from(
    { length: range.endRow - range.startRow + 1 },
    (_, rowOffset) => {
      const rowIndex = range.startRow + rowOffset;
      return Array.from(
        { length: range.endColumn - range.startColumn + 1 },
        (_, columnOffset) =>
          data[rowIndex]?.[range.startColumn + columnOffset] ?? ""
      ).join("\t");
    }
  ).join("\n");
}

function parseDelimitedClipboardText(
  text: string,
  delimiter: string
): SpreadsheetData {
  const rows: SpreadsheetData = [[]];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && character === delimiter) {
      rows[rows.length - 1].push(currentValue);
      currentValue = "";
      continue;
    }

    if (!inQuotes && character === "\n") {
      rows[rows.length - 1].push(currentValue);
      rows.push([]);
      currentValue = "";
      continue;
    }

    currentValue += character;
  }

  rows[rows.length - 1].push(currentValue);

  if (
    rows.length > 1 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === ""
  ) {
    rows.pop();
  }

  return rows;
}

export function parseClipboardText(text: string): SpreadsheetData {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalizedText === "") return [[""]];
  return parseDelimitedClipboardText(
    normalizedText,
    normalizedText.includes("\t") ? "\t" : ","
  );
}
