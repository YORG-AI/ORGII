import { memo } from "react";

import { classNames } from "@src/util/ui/classNames";

import appLogoUrl from "../../../public/logo.png";

export interface AppLogoProps {
  size?: number;
  className?: string;
  alt?: string;
}

/**
 * Canonical ORGII application logo.
 *
 * Importing the existing application asset through webpack keeps onboarding,
 * packaged builds, and the desktop icon on the same visual identity.
 */
const AppLogo = memo<AppLogoProps>(
  ({ size = 32, className, alt = "ORGII" }) => (
    <img
      src={appLogoUrl}
      width={size}
      height={size}
      className={classNames("block flex-shrink-0", className)}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      draggable={false}
    />
  )
);

AppLogo.displayName = "AppLogo";

export default AppLogo;
