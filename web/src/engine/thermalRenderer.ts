import { getGapInDots, getHeightInDots, type PaperSize } from './paperSize.ts';

/**
 * Renders text and images into a 384-pixel wide 1-bit monochrome thermal bitmap.
 * Ported from `Sources/CatPrinterEngine/ThermalBitmapRenderer.swift`.
 */

/** Thermal printhead dot width (standard 58mm paper roll at 203 DPI) */
export const PRINT_WIDTH = 384;

/** Bytes per line: 384 dots / 8 bits = 48 bytes */
export const BYTES_PER_LINE = 48;

export type DitherMode = 'threshold' | 'floydSteinberg';
export type TextAlignmentMode = 'left' | 'center' | 'right';
export type VerticalAlignmentMode = 'top' | 'center' | 'bottom';
export type BorderStyle = 'none' | 'single' | 'rounded' | 'double' | 'topBottom';

export interface TypographyOptions {
  fontSize: number;
  fontName: 'System' | 'Monospaced' | 'Serif' | string;
  isBold: boolean;
  alignment: TextAlignmentMode;
  lineSpacing: number;
  horizontalPadding: number;
  verticalPadding: number;
  ditherMode: DitherMode;
  threshold: number;
  borderStyle: BorderStyle;
  /** Horizontal offset in dots (default -4 dots = -0.5mm, centering on 52mm stickers) */
  horizontalOffset: number;
}

export function createDefaultTypography(overrides: Partial<TypographyOptions> = {}): TypographyOptions {
  return {
    fontSize: 20,
    fontName: 'System',
    isBold: false,
    alignment: 'left',
    lineSpacing: 4,
    horizontalPadding: 8,
    verticalPadding: 8,
    ditherMode: 'threshold',
    threshold: 0.6,
    borderStyle: 'none',
    horizontalOffset: -4,
    ...overrides,
  };
}

/**
 * Converts RGBA pixel buffer (width * height * 4) into 8-bit luminance values (0..255).
 * Transparent pixels are composited over white (255).
 */
export function rgbaToGrayscale(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const count = width * height;
  const gray = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const a = rgba[offset + 3] / 255.0;

    // Composite over white (255, 255, 255)
    const cr = r * a + 255 * (1 - a);
    const cg = g * a + 255 * (1 - a);
    const cb = b * a + 255 * (1 - a);

    // Standard BT.601 luminance
    const lum = Math.round(0.299 * cr + 0.587 * cg + 0.114 * cb);
    gray[i] = Math.max(0, Math.min(255, lum));
  }
  return gray;
}

/**
 * Binarizes an 8-bit grayscale pixel array (width * height) and packs it into
 * 48-byte thermal lines (1 = black/burn, 0 = white, LSB-first: pixel 0 is bit 0).
 */
export function grayscaleToThermalLines(
  grayPixels: Uint8Array,
  width: number,
  height: number,
  ditherMode: DitherMode = 'threshold',
  threshold: number = 0.6
): Uint8Array[] {
  if (height <= 0 || width <= 0) {
    return [];
  }

  const totalPixels = width * height;
  const binaryPixels = new Uint8Array(totalPixels); // 1 = burn, 0 = white

  if (ditherMode === 'threshold') {
    const cutOff = Math.max(0, Math.min(255, Math.floor(threshold * 255.0)));
    for (let i = 0; i < totalPixels; i++) {
      binaryPixels[i] = grayPixels[i] < cutOff ? 1 : 0;
    }
  } else {
    // Floyd-Steinberg error diffusion
    const errorMap = new Float64Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      errorMap[i] = grayPixels[i];
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldVal = errorMap[idx];
        const newVal = oldVal < 128.0 ? 0.0 : 255.0;
        binaryPixels[idx] = newVal === 0.0 ? 1 : 0;
        const err = oldVal - newVal;

        if (x + 1 < width) {
          errorMap[y * width + (x + 1)] += (err * 7.0) / 16.0;
        }
        if (y + 1 < height) {
          if (x > 0) {
            errorMap[(y + 1) * width + (x - 1)] += (err * 3.0) / 16.0;
          }
          errorMap[(y + 1) * width + x] += (err * 5.0) / 16.0;
          if (x + 1 < width) {
            errorMap[(y + 1) * width + (x + 1)] += (err * 1.0) / 16.0;
          }
        }
      }
    }
  }

  // Pack rows into 48-byte packets (LSB-first: pixel 0 is bit 0)
  const lines: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const rowBytes = new Uint8Array(BYTES_PER_LINE);
    const rowOffset = y * width;
    const maxX = Math.min(width, PRINT_WIDTH);

    for (let x = 0; x < maxX; x++) {
      if (binaryPixels[rowOffset + x] === 1) {
        const byteIdx = x >> 3;
        const bitIdx = x & 7;
        rowBytes[byteIdx] |= 1 << bitIdx;
      }
    }
    lines.push(rowBytes);
  }

  return lines;
}

/**
 * Checks whether a 48-byte thermal line is completely blank (all 0x00).
 */
export function isBlankLine(line: Uint8Array): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Trims blank (all 0x00) lines from the beginning of rendered lines to eliminate unwanted gap at start.
 * If `keepPadding` is specified, preserves up to `keepPadding` blank lines before the first content line.
 */
export function trimLeadingBlankLines(lines: ReadonlyArray<Uint8Array>, keepPadding: number = 0): Uint8Array[] {
  let startIndex = 0;
  while (startIndex < lines.length && isBlankLine(lines[startIndex])) {
    startIndex++;
  }
  const adjustedStart = Math.max(0, startIndex - keepPadding);
  return lines.slice(adjustedStart);
}

/**
 * Assembles content lines for a target PaperSize, applying vertical alignment,
 * top offset padding, and label pitch advance to park at the next sticker gap.
 */
export function assembleStickerLines(params: {
  contentLines: ReadonlyArray<Uint8Array>;
  paperSize: PaperSize;
  verticalAlignment?: VerticalAlignmentMode;
  topOffsetDots?: number;
  advanceToNextLabel?: boolean;
  advanceAdjustmentDots?: number;
}): Uint8Array[] {
  const {
    contentLines,
    paperSize,
    verticalAlignment = 'top',
    topOffsetDots = 0,
    advanceToNextLabel = true,
    advanceAdjustmentDots = 0,
  } = params;

  const targetHeight = getHeightInDots(paperSize);
  if (paperSize.kind !== 'sticker' || targetHeight === null) {
    return [...contentLines];
  }

  const createBlank = () => new Uint8Array(BYTES_PER_LINE);
  const result: Uint8Array[] = [];
  let gapAdjustment = advanceAdjustmentDots;

  if (contentLines.length < targetHeight) {
    const totalPad = targetHeight - contentLines.length;
    let topPad = 0;
    let bottomPad = 0;

    switch (verticalAlignment) {
      case 'top':
        topPad = 0;
        bottomPad = totalPad;
        break;
      case 'center':
        topPad = Math.floor(totalPad / 2);
        bottomPad = totalPad - topPad;
        break;
      case 'bottom':
        topPad = totalPad;
        bottomPad = 0;
        break;
    }

    if (topOffsetDots > 0) {
      const addTop = Math.min(topOffsetDots, bottomPad);
      topPad += addTop;
      bottomPad -= addTop;
    } else if (topOffsetDots < 0) {
      const requestedSub = -topOffsetDots;
      const actualSub = Math.min(requestedSub, topPad);
      topPad -= actualSub;
      bottomPad += actualSub;
      // Apply excess upward shift to the inter-label gap advance
      const excessShift = requestedSub - actualSub;
      gapAdjustment -= excessShift;
    }

    for (let i = 0; i < topPad; i++) {
      result.push(createBlank());
    }
    for (const line of contentLines) {
      result.push(line);
    }
    for (let i = 0; i < bottomPad; i++) {
      result.push(createBlank());
    }
  } else {
    for (const line of contentLines) {
      result.push(line);
    }
    if (topOffsetDots < 0) {
      gapAdjustment += topOffsetDots;
    }
  }

  const gapDots = getGapInDots(paperSize);
  if (advanceToNextLabel && gapDots > 0) {
    const finalGap = Math.max(0, gapDots + gapAdjustment);
    for (let i = 0; i < finalGap; i++) {
      result.push(createBlank());
    }
  }

  return result;
}

/**
 * Resolves CSS font-family stack matching the Swift font options.
 */
function resolveFontFamily(fontName: string): string {
  switch (fontName) {
    case 'Monospaced':
      return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    case 'Serif':
      return 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';
    default:
      return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  }
}

/**
 * Word-wraps a single paragraph of text to fit within `maxWidth` on a 2D canvas context.
 */
function wrapParagraph(ctx: CanvasRenderingContext2D, paragraph: string, maxWidth: number): string[] {
  if (paragraph.length === 0) {
    return [''];
  }
  const words = paragraph.split(/(\s+)/);
  const lines: string[] = [];
  let currentLine = '';

  for (const token of words) {
    const testLine = currentLine + token;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine.trim().length > 0) {
      lines.push(currentLine.trimEnd());
      const trimmedToken = token.trimStart();
      // If a single word is wider than maxWidth, break it character by character
      if (ctx.measureText(trimmedToken).width > maxWidth) {
        let charBuf = '';
        for (const ch of trimmedToken) {
          if (ctx.measureText(charBuf + ch).width > maxWidth && charBuf.length > 0) {
            lines.push(charBuf);
            charBuf = ch;
          } else {
            charBuf += ch;
          }
        }
        currentLine = charBuf;
      } else {
        currentLine = trimmedToken;
      }
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine.trimEnd());
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Draws the requested border style onto a 2D canvas context.
 */
function drawBorder(
  ctx: CanvasRenderingContext2D,
  style: BorderStyle,
  rect: { x: number; y: number; width: number; height: number }
): void {
  if (style === 'none') {
    return;
  }

  ctx.save();
  ctx.strokeStyle = '#000000';

  switch (style) {
    case 'single': {
      ctx.lineWidth = 2.0;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      break;
    }
    case 'rounded': {
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(rect.x, rect.y, rect.width, rect.height, 8);
      } else {
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
      }
      ctx.stroke();
      break;
    }
    case 'double': {
      ctx.lineWidth = 2.0;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      const innerX = rect.x + 4;
      const innerY = rect.y + 4;
      const innerW = rect.width - 8;
      const innerH = rect.height - 8;
      if (innerW > 0 && innerH > 0) {
        ctx.lineWidth = 1.0;
        ctx.strokeRect(innerX, innerY, innerW, innerH);
      }
      break;
    }
    case 'topBottom': {
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(rect.x, rect.y);
      ctx.lineTo(rect.x + rect.width, rect.y);
      ctx.moveTo(rect.x, rect.y + rect.height);
      ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

/**
 * Renders multi-line text with optional border onto an HTMLCanvasElement scaled to 384px width.
 */
export function renderTextToCanvas(text: string, options: TypographyOptions): HTMLCanvasElement {
  const trimmed = text.length === 0 ? ' ' : text;
  const width = PRINT_WIDTH;
  const isBordered = options.borderStyle !== 'none';
  const horizontalPadding = isBordered ? Math.max(options.horizontalPadding, 14) : options.horizontalPadding;
  const verticalPadding = isBordered ? Math.max(options.verticalPadding, 10) : options.verticalPadding;

  const baseInsetX = 8;
  const insetY = 4;
  const insetLeft = isBordered
    ? Math.max(1, baseInsetX + options.horizontalOffset)
    : Math.max(0, options.horizontalOffset);
  const insetRight = isBordered ? Math.max(1, baseInsetX - options.horizontalOffset) : 0;

  const borderWidth = Math.max(20, width - insetLeft - insetRight);
  const usableWidth = isBordered
    ? Math.max(20, borderWidth - horizontalPadding * 2)
    : Math.max(20, width - horizontalPadding * 2);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('2D Canvas context is not available');
  }

  const fontWeight = options.isBold ? '700' : '400';
  const fontFamily = resolveFontFamily(options.fontName);
  const fontSpec = `${fontWeight} ${options.fontSize}px ${fontFamily}`;
  ctx.font = fontSpec;

  // Wrap paragraphs
  const rawParagraphs = trimmed.replace(/\r\n/g, '\n').split('\n');
  const wrappedLines: string[] = [];
  for (const para of rawParagraphs) {
    wrappedLines.push(...wrapParagraph(ctx, para, usableWidth));
  }

  const lineHeight = Math.ceil(options.fontSize * 1.18);
  const totalTextHeight =
    wrappedLines.length * lineHeight + Math.max(0, wrappedLines.length - 1) * options.lineSpacing;
  const calculatedHeight = Math.max(
    isBordered ? 28 : 16,
    Math.ceil(totalTextHeight + verticalPadding * 2)
  );

  canvas.width = width;
  canvas.height = calculatedHeight;

  // Re-apply font after resizing canvas
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, calculatedHeight);

  const borderRect = {
    x: insetLeft,
    y: insetY,
    width: borderWidth,
    height: Math.max(20, calculatedHeight - insetY * 2),
  };

  if (isBordered) {
    drawBorder(ctx, options.borderStyle, borderRect);
  }

  const textXBase = isBordered
    ? borderRect.x + horizontalPadding
    : Math.max(0, horizontalPadding + options.horizontalOffset);

  ctx.font = fontSpec;
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  let currentY = verticalPadding;
  for (const line of wrappedLines) {
    let drawX = textXBase;
    if (options.alignment === 'center') {
      ctx.textAlign = 'center';
      drawX = textXBase + usableWidth / 2;
    } else if (options.alignment === 'right') {
      ctx.textAlign = 'right';
      drawX = textXBase + usableWidth;
    } else {
      ctx.textAlign = 'left';
      drawX = textXBase;
    }
    ctx.fillText(line, drawX, currentY);
    currentY += lineHeight + options.lineSpacing;
  }

  return canvas;
}

/**
 * Converts a Canvas or HTMLImageElement into an array of 48-byte thermal lines.
 */
export function canvasToThermalLines(
  source: HTMLCanvasElement | HTMLImageElement | ImageBitmap,
  ditherMode: DitherMode = 'threshold',
  threshold: number = 0.6
): Uint8Array[] {
  const srcWidth =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const srcHeight =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;

  if (srcWidth <= 0 || srcHeight <= 0) {
    return [];
  }

  const width = PRINT_WIDTH;
  const height = Math.max(1, Math.round(srcHeight * (width / srcWidth)));

  const workCanvas = document.createElement('canvas');
  workCanvas.width = width;
  workCanvas.height = height;
  const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return [];
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const gray = rgbaToGrayscale(imageData.data, width, height);
  return grayscaleToThermalLines(gray, width, height, ditherMode, threshold);
}

/**
 * Renders text directly to 48-byte thermal lines.
 */
export function renderTextToThermalLines(text: string, options: TypographyOptions): Uint8Array[] {
  const canvas = renderTextToCanvas(text, options);
  return canvasToThermalLines(canvas, options.ditherMode, options.threshold);
}

/**
 * Automatically adjusts typography (font size, line spacing, vertical padding)
 * down until the rendered text fits within `maxDots` lines.
 */
export function fitTypographyToHeight(
  text: string,
  options: TypographyOptions,
  maxDots: number,
  minFontSize: number = 8
): TypographyOptions {
  const current: TypographyOptions = { ...options };

  const initialLines = renderTextToThermalLines(text, current);
  if (initialLines.length <= maxDots) {
    return current;
  }

  while (current.fontSize > minFontSize) {
    current.fontSize -= 1;

    if (current.fontSize < 16 && current.lineSpacing > 2) {
      current.lineSpacing = Math.max(1, current.lineSpacing - 1);
    }
    if (current.fontSize < 12 && current.verticalPadding > 4) {
      current.verticalPadding = Math.max(2, current.verticalPadding - 2);
    }

    const lines = renderTextToThermalLines(text, current);
    if (lines.length <= maxDots) {
      return current;
    }
  }

  return current;
}

/**
 * Generates centered, bold typography options scaled to maximize font size while fitting inside `targetDots` lines.
 * Used for short text like dates (`dd.MM.yyyy`) or item codes.
 */
export function typographyFittedToHeight(params: {
  text: string;
  targetDots: number;
  maxFontSize?: number;
  minFontSize?: number;
  borderStyle?: BorderStyle;
  horizontalOffset?: number;
}): TypographyOptions {
  const {
    text,
    targetDots,
    maxFontSize = 38,
    minFontSize = 10,
    borderStyle = 'none',
    horizontalOffset = -4,
  } = params;

  let size = maxFontSize;
  const keepPad = borderStyle !== 'none' ? 4 : 0;

  while (size >= minFontSize) {
    const candidate = createDefaultTypography({
      fontSize: size,
      fontName: 'System',
      isBold: true,
      alignment: 'center',
      lineSpacing: 2,
      horizontalPadding: 8,
      verticalPadding: 4,
      ditherMode: 'threshold',
      borderStyle,
      horizontalOffset,
    });

    const lines = renderTextToThermalLines(text, candidate);
    const trimmed = trimLeadingBlankLines(lines, keepPad);
    if (trimmed.length <= targetDots) {
      return candidate;
    }
    size -= 1;
  }

  return createDefaultTypography({
    fontSize: minFontSize,
    isBold: true,
    alignment: 'center',
    borderStyle,
    horizontalOffset,
  });
}

/**
 * Generates a diagnostic test pattern (solid bars, checkerboard, and status banner).
 */
export function generateTestPatternLines(): Uint8Array[] {
  const lines: Uint8Array[] = [];

  const createSolid = () => new Uint8Array(BYTES_PER_LINE).fill(0xff);
  const createBlank = () => new Uint8Array(BYTES_PER_LINE);

  // Top solid separator (8 lines)
  for (let i = 0; i < 8; i++) {
    lines.push(createSolid());
  }

  // 8 blank lines
  for (let i = 0; i < 8; i++) {
    lines.push(createBlank());
  }

  // Checkerboard / alignment grid (24 lines)
  for (let y = 0; y < 24; y++) {
    const row = new Uint8Array(BYTES_PER_LINE);
    for (let i = 0; i < BYTES_PER_LINE; i++) {
      row[i] = (Math.floor(y / 4) + i) % 2 === 0 ? 0xaa : 0x55;
    }
    lines.push(row);
  }

  for (let i = 0; i < 8; i++) {
    lines.push(createBlank());
  }

  // If running in browser with DOM Canvas support, include text banner
  if (typeof document !== 'undefined') {
    const options = createDefaultTypography({
      fontSize: 22,
      isBold: true,
      alignment: 'center',
    });
    const textLines = renderTextToThermalLines('CAT / FUNPRINT\nREADY [OK]', options);
    lines.push(...textLines);
  }

  // Bottom solid separator
  for (let i = 0; i < 8; i++) {
    lines.push(createBlank());
  }
  for (let i = 0; i < 8; i++) {
    lines.push(createSolid());
  }

  return lines;
}

/**
 * Renders an array of 48-byte thermal lines onto a target `<canvas>` element for live preview.
 */
export function renderLinesToPreviewCanvas(lines: ReadonlyArray<Uint8Array>, canvas: HTMLCanvasElement): void {
  const width = PRINT_WIDTH;
  const height = Math.max(1, lines.length);

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  const imageData = ctx.createImageData(width, height);
  const rgba = imageData.data;

  // Fill default off-white paper (#fafafa)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 250;
    rgba[i + 1] = 250;
    rgba[i + 2] = 250;
    rgba[i + 3] = 255;
  }

  for (let y = 0; y < lines.length; y++) {
    const line = lines[y];
    const rowStart = y * width * 4;
    const byteCount = Math.min(line.length, BYTES_PER_LINE);

    for (let byteIdx = 0; byteIdx < byteCount; byteIdx++) {
      const byte = line[byteIdx];
      for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
        const x = byteIdx * 8 + bitIdx;
        if (x < width) {
          const isBlack = (byte & (1 << bitIdx)) !== 0;
          const pixelOffset = rowStart + x * 4;
          const color = isBlack ? 30 : 250; // realistic dark thermal charcoal on off-white paper
          rgba[pixelOffset] = color;
          rgba[pixelOffset + 1] = color;
          rgba[pixelOffset + 2] = color;
          rgba[pixelOffset + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
