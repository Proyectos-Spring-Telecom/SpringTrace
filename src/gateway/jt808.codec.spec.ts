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
    });
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
