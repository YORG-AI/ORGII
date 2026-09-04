/**
 * SVG QR encoder — wraps the vendored MIT qrcode-generator (Kazuhiko Arase).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcodeFactory = require("./qrcodeGeneratorVendor.js") as (
  typeNumber: number,
  errorCorrectionLevel: "L" | "M" | "Q" | "H"
) => {
  addData: (data: string) => void;
  make: () => void;
  getModuleCount: () => number;
  createSvgTag: (options: {
    cellSize?: number;
    margin?: number;
    scalable?: boolean;
    alt?: { text: string | null; id?: string | null };
  }) => string;
};

const QR_MARGIN = 4;

function emptyQrSvg(sizePx: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" role="img"><rect width="100%" height="100%" fill="white"/></svg>`;
}

/** Render `text` as a scalable SVG QR code sized for a square viewport. */
export function buildQrCodeSvg(text: string, sizePx = 140): string {
  const payload = text.trim();
  if (!payload) {
    return emptyQrSvg(sizePx);
  }

  const qr = qrcodeFactory(0, "M");
  qr.addData(payload);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cellSize = Math.max(
    1,
    Math.floor((sizePx - QR_MARGIN * 2) / moduleCount)
  );

  return qr.createSvgTag({
    cellSize,
    margin: QR_MARGIN,
    scalable: true,
    alt: { text: payload },
  });
}
