import { CatPrinterPacket } from './packet.ts';

/**
 * Command identifiers supported by Cat / FunPrint thermal printers.
 */
export const CatCommandId = {
  RETRACT_PAPER: 0xa0,
  FEED_PAPER: 0xa1,
  PRINT_LINE: 0xa2,
  GET_DEVICE_STATE: 0xa3,
  SET_QUALITY: 0xa4,
  LATTICE: 0xa6,
  GET_DEVICE_INFO: 0xa8,
  SET_ENERGY: 0xaf,
  OTHER_FEED_PAPER: 0xbd,
  SET_DRAWING_MODE: 0xbe,
} as const;

export const LATTICE_START_PAYLOAD = new Uint8Array([
  0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c,
]);

export const LATTICE_END_PAYLOAD = new Uint8Array([
  0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17,
]);

function uint16LE(value: number): Uint8Array {
  const clamped = Math.max(0, Math.min(0xffff, Math.round(value)));
  return new Uint8Array([clamped & 0xff, (clamped >> 8) & 0xff]);
}

/**
 * High-level command factory matching `CatPrinterCommand` in Swift.
 */
export const CatPrinterCommand = {
  /** 0xA0: Retract paper by the specified number of steps */
  retractPaper(steps: number): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.RETRACT_PAPER, uint16LE(steps));
  },

  /** 0xA1: Feed paper forward by the specified number of steps (native command) */
  feedPaper(steps: number): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.FEED_PAPER, uint16LE(steps));
  },

  /** 0xA2: Print a single dot line (must be 48 bytes = 384 dots) */
  printLine(data: Uint8Array): CatPrinterPacket {
    if (data.length !== 48) {
      throw new Error(`Thermal print line must be exactly 48 bytes (384 dots), got ${data.length}`);
    }
    return new CatPrinterPacket(CatCommandId.PRINT_LINE, data);
  },

  /**
   * Creates a blank dot line (48 bytes of 0x00).
   * Used for whitespace and as the primary paper-feed workaround on FunPrint / MX-series printers.
   */
  blankLine(): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.PRINT_LINE, new Uint8Array(48));
  },

  /** 0xA3: Query device state */
  getDeviceState(): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.GET_DEVICE_STATE, [0x00]);
  },

  /** 0xA4: Set print quality / DPI (default 0x32 = 200 DPI) */
  setQuality(dpi: number = 0x32): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.SET_QUALITY, [dpi & 0xff]);
  },

  /** 0xA6: Lattice start pattern */
  latticeStart(): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.LATTICE, LATTICE_START_PAYLOAD);
  },

  /** 0xA6: Lattice end pattern */
  latticeEnd(): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.LATTICE, LATTICE_END_PAYLOAD);
  },

  /** 0xA8: Query device info / firmware */
  getDeviceInfo(): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.GET_DEVICE_INFO, [0x00]);
  },

  /** 0xAF: Set thermal heat / energy level (0x0000 - 0xFFFF) */
  setEnergy(level: number): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.SET_ENERGY, uint16LE(level));
  },

  /** 0xBD: Alternative paper feed command */
  otherFeedPaper(speed: number): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.OTHER_FEED_PAPER, [speed & 0xff]);
  },

  /** 0xBE: Set drawing mode (0x00 = image/text, 0x01 = standard) */
  setDrawingMode(mode: number): CatPrinterPacket {
    return new CatPrinterPacket(CatCommandId.SET_DRAWING_MODE, [mode & 0xff]);
  },

  /** Standard initialization handshake sequence for FunPrint and Cat printers */
  initializationSequence(energy: number = 0x7000, qualityDPI: number = 0x32): CatPrinterPacket[] {
    return [
      CatPrinterCommand.getDeviceState(),
      CatPrinterCommand.setQuality(qualityDPI),
      CatPrinterCommand.setEnergy(energy),
      CatPrinterCommand.setDrawingMode(0x01),
    ];
  },
};
