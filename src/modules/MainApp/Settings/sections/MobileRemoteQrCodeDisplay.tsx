import React, { memo, useMemo } from "react";

import { buildQrCodeSvg } from "@src/util/qr/buildQrCodeSvg";

export interface MobileRemoteQrCodeDisplayProps {
  value: string;
  size?: number;
  /** When true, show a dashed placeholder instead of encoding the unresolved URL. */
  unresolved?: boolean;
  ariaLabel: string;
}

const MobileRemoteQrCodeDisplay: React.FC<MobileRemoteQrCodeDisplayProps> =
  memo(({ value, size = 140, unresolved = false, ariaLabel }) => {
    const svgMarkup = useMemo(() => {
      if (unresolved || !value.trim()) {
        return null;
      }
      return buildQrCodeSvg(value, size);
    }, [size, unresolved, value]);

    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-lg border border-border-2 bg-white p-2"
        style={{ width: size + 16, height: size + 16 }}
        aria-label={ariaLabel}
      >
        {svgMarkup ? (
          <div
            className="[&_svg]:block [&_svg]:h-full [&_svg]:w-full"
            style={{ width: size, height: size }}
            // SVG comes from our encoder; payload is already escaped in createSvgTag.
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        ) : (
          <div
            className="flex size-full items-center justify-center rounded-md border border-dashed border-border-3 bg-fill-1 text-[11px] text-text-3"
            style={{ width: size, height: size }}
          >
            QR
          </div>
        )}
      </div>
    );
  });

MobileRemoteQrCodeDisplay.displayName = "MobileRemoteQrCodeDisplay";

export default MobileRemoteQrCodeDisplay;
