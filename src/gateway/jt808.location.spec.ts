import { parseLocation } from './jt808.location';

describe('parseLocation (JT808 0x0200)', () => {
  it('decodifica lat/lng con signo, velocidad y hora China→MX', () => {
    // Status: bit1 posicionado, bit3 Oeste (longitud negativa)
    // lat ≈ 19.432608 → 19432608, lng ≈ 99.133209 → 99133209
    // speed 425 → 42.5 km/h, dir 178, alt 2240
    // time UTC+8: 26-08-05 08:12:30 → MX ≈ 2026-08-04 18:12:30 (UTC-6)
    const body = Buffer.alloc(28);
    body.writeUInt32BE(0x00000000, 0); // alarm
    body.writeUInt32BE(0x0000000a, 4); // status: bit1 + bit3
    body.writeUInt32BE(19_432_608, 8);
    body.writeUInt32BE(99_133_209, 12);
    body.writeUInt16BE(2240, 16);
    body.writeUInt16BE(425, 18);
    body.writeUInt16BE(178, 20);
    Buffer.from([0x26, 0x08, 0x05, 0x08, 0x12, 0x30]).copy(body, 22);

    const location = parseLocation(body);

    expect(location.positionValid).toBe(true);
    expect(location.latitude).toBeCloseTo(19.432608, 6);
    expect(location.longitude).toBeCloseTo(-99.133209, 6);
    expect(location.altitude).toBe(2240);
    expect(location.speedKmh).toBe(42.5);
    expect(location.direction).toBe(178);
    expect(location.timeUtc8).toBe('2026-08-05 08:12:30');
    expect(location.timeLocalMx).toBe('2026-08-04 18:12:30');
    expect(location.extraTlv).toEqual([]);
  });

  it('parsea TLV opcionales de forma tolerante', () => {
    const basic = Buffer.alloc(28);
    basic.writeUInt32BE(0, 0);
    basic.writeUInt32BE(1 << 1, 4);
    basic.writeUInt32BE(0, 8);
    basic.writeUInt32BE(0, 12);
    basic.writeUInt16BE(0, 16);
    basic.writeUInt16BE(0, 18);
    basic.writeUInt16BE(0, 20);
    Buffer.from([0x26, 0x01, 0x01, 0x00, 0x00, 0x00]).copy(basic, 22);

    const tlv = Buffer.from([
      0x01, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0x30, 0x01, 0xff,
    ]);
    const location = parseLocation(Buffer.concat([basic, tlv]));

    expect(location.extraTlv).toEqual([
      { id: 0x01, length: 4 },
      { id: 0x30, length: 1 },
    ]);
  });
});
