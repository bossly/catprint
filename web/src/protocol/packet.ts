import { calculateCRC8 } from './crc8.ts';

/**
 * Represents a framed protocol packet for Cat/FunPrint thermal printers.
 *
 * Packet Format:
 * - Magic Header: [0x51, 0x78] ("Qx")
 * - Command ID: UInt8
 * - Separator: 0x00
 * - Payload Length: UInt16 Little-Endian [len & 0xFF, (len >> 8) & 0xFF]
 * - Payload: Uint8Array
 * - Checksum: CRC-8 calculated exclusively over the payload
 * - Terminator: 0xFF
 */
export class CatPrinterPacket {
  public static readonly HEADER = [0x51, 0x78] as const;
  public static readonly FOOTER = 0xff;

  public readonly command: number;
  public readonly payload: Uint8Array;
  public readonly crc: number;

  constructor(command: number, payload: Uint8Array | ReadonlyArray<number> = new Uint8Array(0)) {
    this.command = command & 0xff;
    this.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    this.crc = calculateCRC8(this.payload);
  }

  /**
   * Serializes the packet into binary data ready to be written over Web Bluetooth.
   */
  public serialize(): Uint8Array {
    const length = this.payload.length;
    const buffer = new Uint8Array(8 + length);

    // Magic 0 & 1 ("Qx")
    buffer[0] = CatPrinterPacket.HEADER[0];
    buffer[1] = CatPrinterPacket.HEADER[1];

    // Command byte
    buffer[2] = this.command;

    // Separator 0x00
    buffer[3] = 0x00;

    // Payload Length (Little-Endian UInt16)
    buffer[4] = length & 0xff;
    buffer[5] = (length >> 8) & 0xff;

    // Payload bytes
    buffer.set(this.payload, 6);

    // CRC-8 over payload
    buffer[6 + length] = this.crc;

    // Terminator 0xFF
    buffer[7 + length] = CatPrinterPacket.FOOTER;

    return buffer;
  }
}
