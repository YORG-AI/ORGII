/** Build-time kill switch for the internal Broker shadow rollout. */
export const isIdentityBrokerEnabled =
  process.env.ORGII_IDENTITY_BROKER !== "disabled";

/**
 * Phase-2 rollout gate. Keep the legacy Cloud credential owner active until
 * the Cloud OAuth client is deployed and Broker access leases replace direct
 * renderer token use.
 */
export const isIdentityOAuthEnabled =
  process.env.ORGII_IDENTITY_OAUTH === "enabled";
