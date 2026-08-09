import type { LucideProps } from "lucide-react";
import { forwardRef } from "react";
import type { SVGProps } from "react";

import McpLogoSvg from "./mcp.svg";

/**
 * Model Context Protocol logo (Wikimedia) — matches Lucide icon usage in toolbars.
 */
type McpLogoIconProps = SVGProps<SVGSVGElement> & Pick<LucideProps, "size">;

export const McpLogoIcon = forwardRef<SVGSVGElement, McpLogoIconProps>(
  ({ size = 24, className, ...rest }, ref) => (
    <McpLogoSvg
      ref={ref}
      width={size}
      height={size}
      className={className}
      aria-hidden
      {...rest}
    />
  )
);

McpLogoIcon.displayName = "McpLogoIcon";
