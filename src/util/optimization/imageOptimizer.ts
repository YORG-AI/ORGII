/**
 * Image Optimizer Utility
 *
 * Optimizes uploaded images for better performance:
 * - Resizes large images to max dimensions
 * - Compresses to target quality
 * - Converts to efficient format (JPEG for photos)
 */
import {
  GIF_LIMITS,
  getGifLimitViolation,
  parseGifMetadata,
  readGifLogicalScreen,
} from "./gifMetadata";

// Browser and storage limits
export const IMAGE_LIMITS = {
  /** Absolute maximum file size (20MB) */
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  /** File size that triggers warning (5MB) */
  WARNING_FILE_SIZE: 5 * 1024 * 1024,
  /** Maximum canvas dimension for safety */
  MAX_DIMENSION: 8192,
  /** Recommended max dimension for performance */
  RECOMMENDED_MAX_DIMENSION: 4096,
};

export interface ImageOptimizeOptions {
  /** Maximum width in pixels (default: 1920) */
  maxWidth?: number;
  /** Maximum height in pixels (default: 1080) */
  maxHeight?: number;
  /** JPEG quality 0-1 (default: 0.85) */
  quality?: number;
  /** Maximum file size in bytes before optimization triggers (default: 500KB) */
  maxFileSizeBytes?: number;
  /** Output format (default: 'image/jpeg') */
  outputFormat?: "image/jpeg" | "image/png" | "image/webp";
  /** Use aggressive optimization for large files (default: false) */
  aggressive?: boolean;
}

export interface OptimizeResult {
  /** Optimized image as base64 data URL */
  dataUrl: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Optimized file size in bytes */
  optimizedSize: number;
  /** Whether optimization was performed */
  wasOptimized: boolean;
  /** Original dimensions */
  originalDimensions: { width: number; height: number };
  /** Final dimensions */
  finalDimensions: { width: number; height: number };
}

const DEFAULT_OPTIONS: Required<ImageOptimizeOptions> = {
  maxWidth: 1920,
  maxHeight: 1080,
  quality: 0.85,
  maxFileSizeBytes: 500 * 1024, // 500KB
  outputFormat: "image/jpeg",
  aggressive: false,
};

/**
 * Custom error class for image optimization errors
 */
export class ImageOptimizationError extends Error {
  constructor(
    message: string,
    public code:
      | "FILE_TOO_LARGE"
      | "DIMENSION_TOO_LARGE"
      | "GIF_LIMIT_EXCEEDED"
      | "LOAD_FAILED"
      | "CANVAS_FAILED"
      | "UNKNOWN"
  ) {
    super(message);
    this.name = "ImageOptimizationError";
  }
}

async function validateGifBeforeDecode(file: File): Promise<void> {
  const header = new Uint8Array(await file.slice(0, 13).arrayBuffer());
  let logicalScreen: { width: number; height: number } | null;
  try {
    logicalScreen = readGifLogicalScreen(header);
  } catch (error) {
    throw new ImageOptimizationError(
      error instanceof Error ? error.message : "GIF header is invalid.",
      "LOAD_FAILED"
    );
  }
  if (!logicalScreen) return;

  // Reject from the 13-byte header before allocating an inspection buffer or
  // handing the file to Chromium's animated-image decoder.
  const headerViolation = getGifLimitViolation(
    {
      ...logicalScreen,
      frameCount: 1,
      estimatedDecodedBytes: logicalScreen.width * logicalScreen.height * 4,
    },
    file.size
  );
  if (
    headerViolation === "FILE_TOO_LARGE" ||
    headerViolation === "DIMENSION_TOO_LARGE"
  ) {
    throw new ImageOptimizationError(
      `GIF exceeds the safe upload limit (${formatBytes(GIF_LIMITS.MAX_FILE_SIZE)}, ${GIF_LIMITS.MAX_DIMENSION}×${GIF_LIMITS.MAX_DIMENSION}).`,
      "GIF_LIMIT_EXCEEDED"
    );
  }

  let metadata;
  try {
    metadata = parseGifMetadata(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new ImageOptimizationError(
      error instanceof Error ? error.message : "GIF metadata is invalid.",
      "LOAD_FAILED"
    );
  }
  if (!metadata) return;

  const violation = getGifLimitViolation(metadata, file.size);
  if (violation) {
    throw new ImageOptimizationError(
      `Animated GIF is too complex to load safely (${metadata.width}×${metadata.height}, ${metadata.frameCount} frames).`,
      "GIF_LIMIT_EXCEEDED"
    );
  }
}

/**
 * Calculate new dimensions while maintaining aspect ratio
 */
const calculateNewDimensions = (
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } => {
  if (width <= maxWidth && height <= maxHeight) {
    return { width, height };
  }

  const widthRatio = maxWidth / width;
  const heightRatio = maxHeight / height;
  const ratio = Math.min(widthRatio, heightRatio);

  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
};

/**
 * Get base64 string size in bytes (approximate)
 */
const getBase64Size = (base64: string): number => {
  // Remove data URL prefix if present
  const base64Data = base64.includes(",") ? base64.split(",")[1] : base64;
  // Base64 encodes 3 bytes into 4 characters
  return Math.round((base64Data.length * 3) / 4);
};

/**
 * Load an image from a File object
 */
const loadImage = (file: File): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new ImageOptimizationError(
          "Failed to load image. The file may be corrupted or in an unsupported format.",
          "LOAD_FAILED"
        )
      );
    };

    img.src = url;
  });
};

/**
 * Compress image using canvas
 */
const compressImage = (
  img: HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
  quality: number,
  format: string
): string => {
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) {
    throw new ImageOptimizationError(
      "Failed to create canvas context. Image may be too large for browser to process.",
      "CANVAS_FAILED"
    );
  }

  // Use high-quality image smoothing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  try {
    // Draw the image scaled to the target dimensions
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    // Convert to data URL with specified quality
    const dataUrl = canvas.toDataURL(format, quality);

    if (!dataUrl || dataUrl === "data:,") {
      throw new Error("Canvas conversion failed");
    }

    return dataUrl;
  } catch (error) {
    throw new ImageOptimizationError(
      "Failed to compress image. The image may be too large or complex.",
      "CANVAS_FAILED"
    );
  }
};

/**
 * Optimize an image file for better performance
 *
 * @param file - The image file to optimize
 * @param options - Optimization options
 * @returns Promise with optimization result
 *
 * @example
 * ```typescript
 * const file = event.target.files[0];
 * const result = await optimizeImage(file);
 * * // Use result.dataUrl for the optimized image
 * ```
 */
export const optimizeImage = async (
  file: File,
  options: ImageOptimizeOptions = {}
): Promise<OptimizeResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalSize = file.size;

  // Validate file size
  if (originalSize > IMAGE_LIMITS.MAX_FILE_SIZE) {
    throw new ImageOptimizationError(
      `File size (${formatBytes(originalSize)}) exceeds maximum allowed size of ${formatBytes(IMAGE_LIMITS.MAX_FILE_SIZE)}.`,
      "FILE_TOO_LARGE"
    );
  }

  await validateGifBeforeDecode(file);

  // Load the image
  const img = await loadImage(file);
  const originalDimensions = { width: img.width, height: img.height };

  // Validate dimensions
  if (
    img.width > IMAGE_LIMITS.MAX_DIMENSION ||
    img.height > IMAGE_LIMITS.MAX_DIMENSION
  ) {
    throw new ImageOptimizationError(
      `Image dimensions (${img.width}×${img.height}) exceed maximum allowed dimensions of ${IMAGE_LIMITS.MAX_DIMENSION}×${IMAGE_LIMITS.MAX_DIMENSION}.`,
      "DIMENSION_TOO_LARGE"
    );
  }

  // Check if optimization is needed
  const needsResize = img.width > opts.maxWidth || img.height > opts.maxHeight;
  const needsCompression = originalSize > opts.maxFileSizeBytes;

  if (!needsResize && !needsCompression) {
    // No optimization needed, return original as base64
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        resolve({
          dataUrl,
          originalSize,
          optimizedSize: originalSize,
          wasOptimized: false,
          originalDimensions,
          finalDimensions: originalDimensions,
        });
      };
      reader.readAsDataURL(file);
    });
  }

  // Calculate target dimensions
  let finalDimensions = calculateNewDimensions(
    img.width,
    img.height,
    opts.maxWidth,
    opts.maxHeight
  );

  // For aggressive optimization of large files, use smaller dimensions
  if (opts.aggressive && originalSize > IMAGE_LIMITS.WARNING_FILE_SIZE) {
    const aggressiveMaxWidth = Math.min(opts.maxWidth, 1600);
    const aggressiveMaxHeight = Math.min(opts.maxHeight, 900);
    finalDimensions = calculateNewDimensions(
      img.width,
      img.height,
      aggressiveMaxWidth,
      aggressiveMaxHeight
    );
  }

  // Compress the image
  let dataUrl = compressImage(
    img,
    finalDimensions.width,
    finalDimensions.height,
    opts.quality,
    opts.outputFormat
  );

  let optimizedSize = getBase64Size(dataUrl);

  // If still too large, reduce quality iteratively
  let currentQuality = opts.quality;
  const minQuality = opts.aggressive ? 0.5 : 0.6; // More aggressive compression if requested

  while (optimizedSize > opts.maxFileSizeBytes && currentQuality > minQuality) {
    currentQuality -= 0.05;
    dataUrl = compressImage(
      img,
      finalDimensions.width,
      finalDimensions.height,
      currentQuality,
      opts.outputFormat
    );
    optimizedSize = getBase64Size(dataUrl);
  }

  return {
    dataUrl,
    originalSize,
    optimizedSize,
    wasOptimized: true,
    originalDimensions,
    finalDimensions,
  };
};

/**
 * Format bytes to human readable string
 */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default optimizeImage;
