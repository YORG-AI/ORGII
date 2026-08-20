import { FILE_API_BASE_URL } from "./constants";

interface FileMtimeResponse {
  mtime: number | null;
}

export async function fetchFileMtime(filePath: string): Promise<number | null> {
  const params = new URLSearchParams({ file_path: filePath });
  const response = await fetch(
    `${FILE_API_BASE_URL}/mtime?${params.toString()}`
  );

  if (!response.ok) {
    return null;
  }

  const result = (await response.json()) as FileMtimeResponse;
  return result.mtime;
}
