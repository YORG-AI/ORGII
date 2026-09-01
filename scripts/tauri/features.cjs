/**
 * Tauri Cargo feature flags by OS.
 */

/**
 * @returns {string[]}
 */
function tauriFeatureList() {
  const features = [];
  if (process.env.WEBDRIVER === "1") {
    features.push("webdriver");
  }
  return features;
}

/**
 * @returns {string}
 */
function tauriFeatureString() {
  return tauriFeatureList().join(",");
}

module.exports = { tauriFeatureList, tauriFeatureString };
