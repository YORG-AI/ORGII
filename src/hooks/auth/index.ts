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
  serviceLoadingAtom,
  hostedTokenAtom,
  serviceExpiryAtom,
  serviceErrorAtom,
  serviceValidatedAtom,
  serviceRefreshingAtom,
} from "./useServiceAuth";
export type {
  UseServiceAuthReturn,
  UseServiceAuthStateReturn,
} from "./useServiceAuth";
