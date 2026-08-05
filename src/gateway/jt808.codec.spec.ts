import {
  buildMessage,
  calcChecksum,
  escape,
  Jt808FrameDecoder,
  parseHeader,
  unescape,
} from './jt808.codec';

describe('JT808 codec', () => {
  it('aplica y revierte la transparencia de 0x7e y 0x7d', () => {
    const source = Buffer.from([0x01, 0x7e, 0x7d, 0x02]);
    const escaped = Buffer.from([0x01, 0x7d, 0x02, 0x7d, 0x01, 0x02]);

    expect(escape(source)).toEqual(escaped);
    expect(unescape(escaped)).toEqual(source);
  });

  it('construye y parsea una trama JT808:2011 completa', () => {
    const body = Buffer.from('AE-DI5052-G40 PRO', 'ascii');
    const frame = buildMessage(0x0100, '007773050481', 8, body);

    expect(frame[0]).toBe(0x7e);
    expect(frame[frame.length - 1]).toBe(0x7e);

    const decoded = unescape(frame.subarray(1, frame.length - 1));
    const payload = decoded.subarray(0, decoded.length - 1);
    expect(decoded[decoded.length - 1]).toBe(calcChecksum(payload));
    expect(parseHeader(payload)).toEqual({
      messageId: 0x0100,
      bodyLength: body.length,
      terminalId: '007773050481',
      serialNumber: 8,
      body,
      headerLength: 12,
      hasSubpackages: false,
      packageTotal: undefined,
      packageNo: undefined,
    });
  });

  it('parsea cabecera con subpaquetes (bit 13)', () => {
    const fragment = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const payload = Buffer.alloc(16 + fragment.length);
    payload.writeUInt16BE(0x0801, 0);
    payload.writeUInt16BE(0x2000 | fragment.length, 2); // bit 13 + body len
    Buffer.from('007773050481', 'hex').copy(payload, 4);
    payload.writeUInt16BE(42, 10);
    payload.writeUInt16BE(3, 12); // total
    payload.writeUInt16BE(2, 14); // package no
    fragment.copy(payload, 16);

    const header = parseHeader(payload);
    expect(header.hasSubpackages).toBe(true);
    expect(header.headerLength).toBe(16);
    expect(header.packageTotal).toBe(3);
    expect(header.packageNo).toBe(2);
    expect(header.body).toEqual(fragment);
  });

  it('ensambla tramas partidas y varias tramas en un solo chunk', () => {
    const first = buildMessage(0x0002, '007773050481', 9, Buffer.alloc(0));
    const second = buildMessage(
      0x0102,
      '007773050481',
      10,
      Buffer.from('JT808-007773050481', 'ascii'),
    );
    const decoder = new Jt808FrameDecoder();
    const splitAt = 7;

    expect(decoder.push(first.subarray(0, splitAt))).toEqual([]);
    const frames = decoder.push(
      Buffer.concat([first.subarray(splitAt), second]),
    );

    expect(frames).toHaveLength(2);
    expect(unescape(frames[0]).readUInt16BE(0)).toBe(0x0002);
    expect(unescape(frames[1]).readUInt16BE(0)).toBe(0x0102);
  });
});
