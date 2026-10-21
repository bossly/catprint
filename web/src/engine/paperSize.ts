/**
 * Defines paper types and dimensions for portable thermal printers.
 * Ported from `Sources/CatPrinterEngine/PaperSize.swift`.
 */

export type PaperKind = 'continuous' | 'sticker';

export interface PaperSize {
  readonly id: string;
  readonly name: string;
  readonly kind: PaperKind;
  readonly widthMm: number;
  readonly heightMm: number | null; // null for continuous roll
  readonly gapMm: number; // inter-label gap in mm (standard ~2.0mm or 8.0mm)
}

/** Printable head width in dots (hardware constraint: 48mm at 8 dots/mm = 384 dots) */
export const PRINTABLE_DOTS_WIDTH = 384;

/**
 * Height in dots at standard 203 DPI (8.0 dots per mm).
 * For example, 15 mm = 120 dots.
 */
export function getHeightInDots(paper: PaperSize): number | null {
  if (paper.heightMm === null) {
    return null;
  }
  return Math.max(1, Math.round(paper.heightMm * 8.0));
}

/**
 * Inter-label gap in dots at 203 DPI (8.0 dots per mm).
 * For example, 8 mm = 64 dots, 2 mm = 16 dots.
 */
export function getGapInDots(paper: PaperSize): number {
  if (paper.kind !== 'sticker') {
    return 0;
  }
  return Math.max(0, Math.round(paper.gapMm * 8.0));
}

/**
 * Total pitch in dots (label height + gap).
 */
export function getPitchInDots(paper: PaperSize): number | null {
  const heightDots = getHeightInDots(paper);
  if (heightDots === null) {
    return null;
  }
  return heightDots + getGapInDots(paper);
}

/** Standard presets matching `PaperSize.swift` */
export const PaperPresets = {
  /** Standard continuous 57mm / 58mm thermal receipt roll */
  continuous57: {
    id: 'continuous_57',
    name: 'Continuous Roll (57 mm)',
    kind: 'continuous',
    widthMm: 57.0,
    heightMm: null,
    gapMm: 0.0,
  } satisfies PaperSize,

  /** 52 × 10 mm die-cut sticker label (80 dots high, 8mm gap = 18mm pitch) */
  sticker52x10: {
    id: 'sticker_52x10',
    name: 'Sticker: 52 × 10 mm',
    kind: 'sticker',
    widthMm: 52.0,
    heightMm: 10.0,
    gapMm: 8.0,
  } satisfies PaperSize,

  /** 52 × 15 mm die-cut sticker label (120 dots high, 8mm gap = 23mm pitch) */
  sticker52x15: {
    id: 'sticker_52x15',
    name: 'Sticker: 52 × 15 mm',
    kind: 'sticker',
    widthMm: 52.0,
    heightMm: 15.0,
    gapMm: 8.0,
  } satisfies PaperSize,

  /** 52 × 30 mm die-cut sticker label (240 dots high) */
  sticker52x30: {
    id: 'sticker_52x30',
    name: 'Sticker: 52 × 30 mm',
    kind: 'sticker',
    widthMm: 52.0,
    heightMm: 30.0,
    gapMm: 2.0,
  } satisfies PaperSize,

  /** 50 × 15 mm die-cut sticker label (120 dots high) */
  sticker50x15: {
    id: 'sticker_50x15',
    name: 'Sticker: 50 × 15 mm',
    kind: 'sticker',
    widthMm: 50.0,
    heightMm: 15.0,
    gapMm: 2.0,
  } satisfies PaperSize,

  /** 50 × 30 mm die-cut sticker label (240 dots high) */
  sticker50x30: {
    id: 'sticker_50x30',
    name: 'Sticker: 50 × 30 mm',
    kind: 'sticker',
    widthMm: 50.0,
    heightMm: 30.0,
    gapMm: 2.0,
  } satisfies PaperSize,
} as const;

export const STANDARD_PAPER_PRESETS: ReadonlyArray<PaperSize> = [
  PaperPresets.sticker52x15,
  PaperPresets.sticker52x10,
  PaperPresets.sticker52x30,
  PaperPresets.sticker50x15,
  PaperPresets.sticker50x30,
  PaperPresets.continuous57,
];

/**
 * Evaluation of how rendered lines fit onto a chosen PaperSize.
 */
export interface PaperFitInfo {
  readonly paperSize: PaperSize;
  readonly contentLines: number;
  readonly capacityLines: number | null;
  readonly fits: boolean;
  readonly overflowLines: number;
  readonly usagePercentage: number | null;
}

export function evaluatePaperFit(paperSize: PaperSize, contentLines: number): PaperFitInfo {
  const capacity = getHeightInDots(paperSize);
  if (capacity !== null) {
    const fits = contentLines <= capacity;
    const overflowLines = fits ? 0 : contentLines - capacity;
    const usagePercentage = capacity > 0 ? (contentLines / capacity) * 100.0 : 0.0;
    return {
      paperSize,
      contentLines,
      capacityLines: capacity,
      fits,
      overflowLines,
      usagePercentage,
    };
  }

  return {
    paperSize,
    contentLines,
    capacityLines: null,
    fits: true,
    overflowLines: 0,
    usagePercentage: null,
  };
}
