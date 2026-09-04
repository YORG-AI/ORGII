/** True when the page runs as an installed home-screen web app (iOS or Android). */
export function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = window.navigator as Navigator & {
    standalone?: boolean;
  };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}
