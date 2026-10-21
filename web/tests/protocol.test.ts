import { describe, expect, it } from 'vitest';
import { calculateCRC8 } from '../src/protocol/crc8.ts';
import { CatCommandId, CatPrinterCommand } from '../src/protocol/command.ts';

describe('CatPrinterProtocol (Web)', () => {
  it('calculates known CRC-8 vectors accurately', () => {
    // From captured packet: Qx \xa4 \x00 \x01 \x00 2 \x9e \xff
    // Payload is '2' (0x32), CRC8 is 0x9E
    expect(calculateCRC8([0x32])).toBe(0x9e);

    // From captured packet: Qx \xaf \x00 \x02 \x00 \x00 \x20 \xe0 \xff
    // Payload is [0x00, 0x20], CRC8 is 0xE0
    expect(calculateCRC8([0x00, 0x20])).toBe(0xe0);

    // Zero payload test
    expect(calculateCRC8([0x00])).toBe(0x00);

    // Single byte 0x01 test
    expect(calculateCRC8([0x01])).toBe(0x07);
  });

  it('serializes SetQuality packet identically to Swift protocol', () => {
    const packet = CatPrinterCommand.setQuality(0x32);
    const serialized = Array.from(packet.serialize());
    expect(serialized).toEqual([0x51, 0x78, 0xa4, 0x00, 0x01, 0x00, 0x32, 0x9e, 0xff]);
  });

  it('serializes BlankLine packet (56 bytes total)', () => {
    const blankLine = CatPrinterCommand.blankLine();
    const serialized = blankLine.serialize();

    // 2 (header) + 1 (cmd) + 1 (0x00) + 2 (length) + 48 (payload) + 1 (crc) + 1 (footer) = 56 bytes
    expect(serialized.length).toBe(56);
    expect(serialized[0]).toBe(0x51);
    expect(serialized[1]).toBe(0x78);
    expect(serialized[2]).toBe(0xa2);
    expect(serialized[3]).toBe(0x00);
    expect(serialized[4]).toBe(0x30); // 48 in hex
    expect(serialized[5]).toBe(0x00);
    expect(serialized[55]).toBe(0xff);
  });

  it('serializes FeedPaper packet with 16-bit little-endian steps', () => {
    const feedCmd = CatPrinterCommand.feedPaper(120);
    const serialized = feedCmd.serialize();

    expect(serialized.length).toBe(10);
    expect(serialized[0]).toBe(0x51);
    expect(serialized[1]).toBe(0x78);
    expect(serialized[2]).toBe(0xa1);
    expect(serialized[3]).toBe(0x00);
    expect(serialized[4]).toBe(0x02); // len low
    expect(serialized[5]).toBe(0x00); // len high
    expect(serialized[6]).toBe(120); // steps low
    expect(serialized[7]).toBe(0); // steps high
    expect(serialized[9]).toBe(0xff);
  });

  it('builds the 4-packet initialization handshake sequence', () => {
    const initPackets = CatPrinterCommand.initializationSequence();
    expect(initPackets.length).toBe(4);
    expect(initPackets[0].command).toBe(CatCommandId.GET_DEVICE_STATE); // 0xA3
    expect(initPackets[1].command).toBe(CatCommandId.SET_QUALITY); // 0xA4
    expect(initPackets[2].command).toBe(CatCommandId.SET_ENERGY); // 0xAF
    expect(initPackets[3].command).toBe(CatCommandId.SET_DRAWING_MODE); // 0xBE
  });

  it('rejects printLine payloads that are not 48 bytes', () => {
    expect(() => CatPrinterCommand.printLine(new Uint8Array(10))).toThrow(
      /must be exactly 48 bytes/
    );
  });
});
