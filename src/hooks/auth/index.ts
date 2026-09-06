/**
 * Authentication Hooks
 *
 * Hosted service OAuth authentication only.
 * For CLI agent credentials, see @src/hooks/keyVault.
 */
export {
  useServiceAuth,
  useServiceAuthState,
  serviceAuthAtom,
  hostedTokenAtom,
  serviceExpiryAtom,
  serviceValidatedAtom,
} from "./useServiceAuth";
