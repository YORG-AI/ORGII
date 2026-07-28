import { memo } from "react";

import type { BuilderTypeDefinition } from "./builderTypes";

interface BuilderTypeAvatarProps {
  type: BuilderTypeDefinition;
  className?: string;
  eager?: boolean;
}

const BuilderTypeAvatar = memo(function BuilderTypeAvatar({
  type,
  className = "",
  eager = false,
}: BuilderTypeAvatarProps) {
  return (
    <img
      src={type.avatar}
      alt=""
      width={640}
      height={640}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={`aspect-square object-contain ${className}`}
      data-testid={`builder-type-avatar-${type.code}`}
    />
  );
});

export default BuilderTypeAvatar;
