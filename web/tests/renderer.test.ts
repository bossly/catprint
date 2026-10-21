import { describe, expect, it } from 'vitest';
import {
  evaluatePaperFit,
  getGapInDots,
  getHeightInDots,
  getPitchInDots,
  PaperPresets,
} from '../src/engine/paperSize.ts';
import {
  assembleStickerLines,
  BYTES_PER_LINE,
  generateTestPatternLines,
  grayscaleToThermalLines,
  isBlankLine,
  PRINT_WIDTH,
  rgbaToGrayscale,
  trimLeadingBlankLines,
} from '../src/engine/thermalRenderer.ts';

describe('PaperSize & ThermalRenderer (Web)', () => {
  it('computes paper dimensions and dot pitches accurately', () => {
    // 52x15 mm sticker: 15mm * 8 dots/mm = 120 dots, 8mm gap * 8 = 64 dots -> 184 dots pitch
    const sticker = PaperPresets.sticker52x15;
    expect(getHeightInDots(sticker)).toBe(120);
    expect(getGapInDots(sticker)).toBe(64);
    expect(getPitchInDots(sticker)).toBe(184);
    expect(sticker.kind).toBe('sticker');

    // 52x10 mm sticker: 10mm * 8 = 80 dots, 8mm gap * 8 = 64 dots -> 144 dots pitch
    const sticker10 = PaperPresets.sticker52x10;
    expect(getHeightInDots(sticker10)).toBe(80);
    expect(getGapInDots(sticker10)).toBe(64);
    expect(getPitchInDots(sticker10)).toBe(144);

    // 52x30 mm sticker: 30mm * 8 = 240 dots, 2mm gap * 8 = 16 dots -> 256 dots pitch
    const sticker30 = PaperPresets.sticker52x30;
    expect(getHeightInDots(sticker30)).toBe(240);
    expect(getGapInDots(sticker30)).toBe(16);
    expect(getPitchInDots(sticker30)).toBe(256);

    // Continuous 57mm roll
    const continuous = PaperPresets.continuous57;
    expect(getHeightInDots(continuous)).toBeNull();
    expect(getGapInDots(continuous)).toBe(0);
    expect(getPitchInDots(continuous)).toBeNull();
    expect(continuous.kind).toBe('continuous');
  });

  it('evaluates paper fit and overflow accurately', () => {
    const sticker = PaperPresets.sticker52x15; // 120 dots

    const fitInfo1 = evaluatePaperFit(sticker, 84);
    expect(fitInfo1.fits).toBe(true);
    expect(fitInfo1.overflowLines).toBe(0);
    expect(fitInfo1.capacityLines).toBe(120);
    expect(Math.floor(fitInfo1.usagePercentage ?? 0)).toBe(70);

    const fitInfo2 = evaluatePaperFit(sticker, 155);
    expect(fitInfo2.fits).toBe(false);
    expect(fitInfo2.overflowLines).toBe(35);
    expect(fitInfo2.capacityLines).toBe(120);
    expect(fitInfo2.usagePercentage).toBeGreaterThan(100);

    const fitInfo3 = evaluatePaperFit(PaperPresets.continuous57, 200);
    expect(fitInfo3.fits).toBe(true);
    expect(fitInfo3.overflowLines).toBe(0);
    expect(fitInfo3.capacityLines).toBeNull();
    expect(fitInfo3.usagePercentage).toBeNull();
  });

  it('packs 384-pixel grayscale rows into 48-byte LSB-first thermal lines', () => {
    const gray = new Uint8Array(PRINT_WIDTH * 2).fill(255); // 2 rows of white
    // Set pixel 0 and pixel 7 of row 0 to black (0) -> byte 0 should be (1 << 0) | (1 << 7) = 0x81
    gray[0] = 0;
    gray[7] = 0;
    // Set all pixels of row 1 to black (0) -> all 48 bytes should be 0xFF
    for (let x = 0; x < PRINT_WIDTH; x++) {
      gray[PRINT_WIDTH + x] = 0;
    }

    const lines = grayscaleToThermalLines(gray, PRINT_WIDTH, 2, 'threshold', 0.5);
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBe(BYTES_PER_LINE);
    expect(lines[0][0]).toBe(0x81);
    expect(lines[0][1]).toBe(0x00);

    for (let b = 0; b < BYTES_PER_LINE; b++) {
      expect(lines[1][b]).toBe(0xff);
    }
  });

  it('performs Floyd-Steinberg dithering on mid-gray gradients', () => {
    const gray = new Uint8Array(PRINT_WIDTH * 4).fill(128); // 50% gray
    const lines = grayscaleToThermalLines(gray, PRINT_WIDTH, 4, 'floydSteinberg');
    expect(lines.length).toBe(4);
    // Should produce a mix of black and white pixels (not all 0x00 and not all 0xFF)
    const nonZeroBytes = lines[1].filter((b) => b !== 0x00 && b !== 0xff);
    expect(nonZeroBytes.length).toBeGreaterThan(20);
  });

  it('converts RGBA buffers to grayscale composited over white', () => {
    // 2 pixels: pixel 0 = opaque black (0,0,0,255), pixel 1 = transparent black (0,0,0,0)
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
    const gray = rgbaToGrayscale(rgba, 2, 1);
    expect(gray[0]).toBe(0);
    expect(gray[1]).toBe(255);
  });

  it('trims leading blank lines with optional keepPadding', () => {
    const blank = new Uint8Array(BYTES_PER_LINE);
    const content = new Uint8Array(BYTES_PER_LINE).fill(0xaa);

    const testLines = [
      ...Array.from({ length: 10 }, () => blank),
      content,
      content,
    ];

    const trimmedNoPad = trimLeadingBlankLines(testLines, 0);
    expect(trimmedNoPad.length).toBe(2);
    expect(trimmedNoPad[0]).toEqual(content);

    const trimmedWithPad = trimLeadingBlankLines(testLines, 4);
    expect(trimmedWithPad.length).toBe(6);
    expect(isBlankLine(trimmedWithPad[0])).toBe(true);
    expect(isBlankLine(trimmedWithPad[3])).toBe(true);
    expect(trimmedWithPad[4]).toEqual(content);
    expect(trimmedWithPad[5]).toEqual(content);
  });

  it('assembles sticker lines with center alignment, top alignment, and negative top offset', () => {
    const sticker = PaperPresets.sticker52x15; // 120 dots, 64 gap dots (total 184)
    const dummyLine = new Uint8Array(BYTES_PER_LINE).fill(0xff);
    const content60 = Array.from({ length: 60 }, () => dummyLine);

    // 1. Center aligned with advance to next label
    const centerAssembled = assembleStickerLines({
      contentLines: content60,
      paperSize: sticker,
      verticalAlignment: 'center',
      advanceToNextLabel: true,
    });
    expect(centerAssembled.length).toBe(184);
    for (let i = 0; i < 30; i++) {
      expect(isBlankLine(centerAssembled[i])).toBe(true);
    }
    for (let i = 30; i < 90; i++) {
      expect(centerAssembled[i]).toEqual(dummyLine);
    }
    for (let i = 90; i < 184; i++) {
      expect(isBlankLine(centerAssembled[i])).toBe(true);
    }

    // 2. Top aligned with negative top offset (-28 dots reduces trailing gap advance from 64 to 36)
    const content78 = Array.from({ length: 78 }, () => dummyLine);
    const negOffsetAssembled = assembleStickerLines({
      contentLines: content78,
      paperSize: sticker,
      verticalAlignment: 'top',
      topOffsetDots: -28,
      advanceToNextLabel: true,
    });
    expect(negOffsetAssembled.length).toBe(156);
  });

  it('generates hardware test pattern lines', () => {
    const pattern = generateTestPatternLines();
    expect(pattern.length).toBeGreaterThan(20);
    for (const line of pattern) {
      expect(line.length).toBe(48);
    }
  });
});
