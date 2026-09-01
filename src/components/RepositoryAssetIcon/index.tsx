import React from "react";

import "./index.scss";

type RepositorySvgAsset = React.FC<React.SVGProps<SVGSVGElement>> | string;

interface RepositoryAssetIconProps extends Omit<
  React.SVGAttributes<SVGSVGElement>,
  "children"
> {
  source: RepositorySvgAsset;
  size?: number | string;
}

/**
 * Adapts an existing repository SVG asset to the product's monochrome icon
 * treatment while preserving multi-layer artwork through tonal opacity.
 */
const RepositoryAssetIcon: React.FC<RepositoryAssetIconProps> = ({
  source,
  size = 16,
  className = "",
  ...rest
}) => {
  const resolvedClassName = `repository-asset-icon ${className}`.trim();

  // Vitest resolves static SVG imports to URLs; production webpack resolves
  // the same assets to SVGR components. Keep both environments deterministic.
  if (typeof source === "string") {
    return (
      <span
        className={resolvedClassName}
        aria-hidden={rest["aria-hidden"]}
        style={{
          width: size,
          height: size,
          backgroundColor: "currentColor",
          WebkitMask: `url("${source}") center / contain no-repeat`,
          mask: `url("${source}") center / contain no-repeat`,
        }}
      />
    );
  }

  const Source = source;
  return (
    <Source
      width={size}
      height={size}
      className={resolvedClassName}
      {...rest}
    />
  );
};

RepositoryAssetIcon.displayName = "RepositoryAssetIcon";

interface BoundRepositoryAssetIconProps extends Omit<
  RepositoryAssetIconProps,
  "source"
> {}

export function createRepositoryAssetIcon(
  source: RepositorySvgAsset,
  displayName: string
): React.ComponentType<BoundRepositoryAssetIconProps> {
  const BoundRepositoryAssetIcon: React.FC<BoundRepositoryAssetIconProps> = (
    props
  ) => <RepositoryAssetIcon source={source} {...props} />;
  BoundRepositoryAssetIcon.displayName = displayName;
  return BoundRepositoryAssetIcon;
}

export default RepositoryAssetIcon;
