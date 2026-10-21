export { CRC8_TABLE, calculateCRC8 } from './protocol/crc8.ts';
export { CatPrinterPacket } from './protocol/packet.ts';
export {
  CatCommandId,
  CatPrinterCommand,
  LATTICE_END_PAYLOAD,
  LATTICE_START_PAYLOAD,
} from './protocol/command.ts';
export {
  evaluatePaperFit,
  getGapInDots,
  getHeightInDots,
  getPitchInDots,
  PaperPresets,
  PRINTABLE_DOTS_WIDTH,
  STANDARD_PAPER_PRESETS,
  type PaperFitInfo,
  type PaperKind,
  type PaperSize,
} from './engine/paperSize.ts';
export {
  assembleStickerLines,
  BYTES_PER_LINE,
  canvasToThermalLines,
  createDefaultTypography,
  fitTypographyToHeight,
  generateTestPatternLines,
  grayscaleToThermalLines,
  isBlankLine,
  PRINT_WIDTH,
  renderLinesToPreviewCanvas,
  renderTextToCanvas,
  renderTextToThermalLines,
  rgbaToGrayscale,
  trimLeadingBlankLines,
  typographyFittedToHeight,
  type BorderStyle,
  type DitherMode,
  type TextAlignmentMode,
  type TypographyOptions,
  type VerticalAlignmentMode,
} from './engine/thermalRenderer.ts';
export {
  CatPrinterService,
  type CatPrinterEvents,
  type FeedMode,
  type PrinterConnectionState,
  type PrinterSettings,
} from './service/catPrinterService.ts';
