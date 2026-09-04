/** Derive a human-readable device label from the mobile browser environment. */
export function resolveMobileDeviceLabel(): string {
  if (typeof navigator === "undefined") {
    return "ORGII Mobile";
  }

  const ua = navigator.userAgent;

  if (/iPad/.test(ua)) {
    return "iPad";
  }
  if (/iPhone|iPod/.test(ua)) {
    return "iPhone";
  }
  if (/Android/i.test(ua)) {
    const modelMatch = ua.match(/Android[^;]*;\s*([^)]+)\)/i);
    const model = modelMatch?.[1]?.trim();
    if (model && !/^Linux/i.test(model)) {
      return model.slice(0, 40);
    }
    return "Android phone";
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return "Mac browser";
  }
  if (/Windows/i.test(ua)) {
    return "Windows browser";
  }
  if (/CrOS/i.test(ua)) {
    return "Chromebook browser";
  }
  if (/Linux/i.test(ua)) {
    return "Linux browser";
  }

  const platform = navigator.platform?.trim();
  if (platform) {
    return platform.slice(0, 40);
  }

  return "ORGII Mobile";
}
