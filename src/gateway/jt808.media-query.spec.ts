import {
  buildStoredMediaQueryBody,
  parseStoredMediaQueryResponse,
  parseTerminalGeneralResponse,
} from './jt808.media-query';

describe('JT808 stored media query', () => {
  it('parsea 0x0001 aceptando un comando 0x8805', () => {
    const body = Buffer.from([0x00, 0x59, 0x88, 0x05, 0x00]);

    expect(parseTerminalGeneralResponse(body)).toEqual({
      responseSerial: 0x0059,
      responseMessageId: 0x8805,
      result: 0,
      resultLabel: 'éxito',
    });
  });

  it('construye 0x8802 sin límites para todas las imágenes', () => {
    expect(buildStoredMediaQueryBody()).toEqual(Buffer.alloc(15, 0));
  });

  it('parsea todos los items de 0x0802', () => {
    const body = Buffer.alloc(4 + 2 * 35);
    body.writeUInt16BE(0x0060, 0);
    body.writeUInt16BE(2, 2);

    body.writeUInt32BE(0x3e9, 4);
    body[8] = 0;
    body[9] = 2;
    body[10] = 0;

    const second = 4 + 35;
    body.writeUInt32BE(0x3ea, second);
    body[second + 4] = 0;
    body[second + 5] = 2;
    body[second + 6] = 1;

    const parsed = parseStoredMediaQueryResponse(body);
    expect(parsed.responseSerial).toBe(0x0060);
    expect(parsed.totalItems).toBe(2);
    expect(parsed.items).toEqual([
      expect.objectContaining({
        multimediaId: 0x3e9,
        mediaType: 0,
        channelId: 2,
        eventCode: 0,
      }),
      expect.objectContaining({
        multimediaId: 0x3ea,
        mediaType: 0,
        channelId: 2,
        eventCode: 1,
      }),
    ]);
  });
});
