interface SuppressedRestoredSubmit {
  sessionId: string;
  displayContent: string;
  imageDataUrls: string[];
  expiresAt: number;
}

const restoredSubmitSuppression: SuppressedRestoredSubmit = {
  sessionId: "",
  displayContent: "",
  imageDataUrls: [],
  expiresAt: 0,
};

const restoredStopDraftsBySessionId = new Map<
  string,
  { displayContent: string; imageDataUrls: string[] }
>();

function normalizedImages(imageDataUrls?: string[]): string[] {
  return imageDataUrls ?? [];
}

export function suppressRestoredStopSubmit(options: {
  sessionId: string;
  displayContent: string;
  imageDataUrls?: string[];
  ttlMs?: number;
}): void {
  restoredSubmitSuppression.sessionId = options.sessionId;
  restoredSubmitSuppression.displayContent = options.displayContent;
  restoredSubmitSuppression.imageDataUrls = normalizedImages(
    options.imageDataUrls
  );
  restoredSubmitSuppression.expiresAt = Date.now() + (options.ttlMs ?? 50);
}

export function markRestoredStopDraft(options: {
  sessionId: string;
  displayContent: string;
  imageDataUrls?: string[];
}): void {
  restoredStopDraftsBySessionId.set(options.sessionId, {
    displayContent: options.displayContent,
    imageDataUrls: normalizedImages(options.imageDataUrls),
  });
}

export function consumeRestoredStopDraft(options: {
  sessionId: string;
  displayContent: string;
  imageDataUrls?: string[];
}): boolean {
  const restored = restoredStopDraftsBySessionId.get(options.sessionId);
  if (!restored) return false;
  if (restored.displayContent !== options.displayContent) return false;
  if (
    JSON.stringify(restored.imageDataUrls) !==
    JSON.stringify(normalizedImages(options.imageDataUrls))
  ) {
    return false;
  }
  restoredStopDraftsBySessionId.delete(options.sessionId);
  return true;
}

export function consumeRestoredStopSubmitSuppression(options: {
  sessionId: string;
  displayContent: string;
  imageDataUrls?: string[];
  now?: number;
}): boolean {
  const now = options.now ?? Date.now();
  if (restoredSubmitSuppression.expiresAt <= now) return false;
  if (restoredSubmitSuppression.sessionId !== options.sessionId) return false;
  if (restoredSubmitSuppression.displayContent !== options.displayContent) {
    return false;
  }
  const incomingImages = normalizedImages(options.imageDataUrls);
  if (
    JSON.stringify(restoredSubmitSuppression.imageDataUrls) !==
    JSON.stringify(incomingImages)
  ) {
    return false;
  }
  restoredSubmitSuppression.expiresAt = 0;
  return true;
}
