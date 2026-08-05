import {
  buildCameraShootBody,
  buildMultimediaUploadAck,
  parseCameraControlResponse,
  parseMultimediaUpload,
  SubpackageAssembler,
} from './jt808.multimedia';

describe('JT808 multimedia', () => {
  it('construye cuerpo 0x8801 con defaults de prueba', () => {
    const body = buildCameraShootBody({ channelId: 1 });
    expect(body.length).toBe(12);
    expect(body[0]).toBe(1);
    expect(body.readUInt16BE(1)).toBe(1);
    expect(body.readUInt16BE(3)).toBe(0);
    expect(body[5]).toBe(1);
    expect(body[6]).toBe(0);
    expect(body[7]).toBe(5);
  });

  it('parsea 0x0805 con éxito e IDs multimedia', () => {
    const body = Buffer.alloc(5 + 4);
    body.writeUInt16BE(15, 0);
    body[2] = 0;
    body.writeUInt16BE(1, 3);
    body.writeUInt32BE(0x12345678, 5);

    expect(parseCameraControlResponse(body)).toEqual({
      responseSerial: 15,
      result: 0,
      resultLabel: 'éxito',
      multimediaIds: [0x12345678],
    });
  });

  it('parsea 0x0805 con rechazo de canal', () => {
    const body = Buffer.from([0x00, 0x0a, 0x02]);
    const parsed = parseCameraControlResponse(body);
    expect(parsed.result).toBe(2);
    expect(parsed.resultLabel).toBe('canal no soportado');
    expect(parsed.multimediaIds).toEqual([]);
  });

  it('reensambla subpaquetes y extrae JPEG del 0x0801', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const complete = Buffer.alloc(36 + jpeg.length);
    complete.writeUInt32BE(99, 0);
    complete[4] = 0; // image
    complete[5] = 0; // jpeg
    complete[6] = 0;
    complete[7] = 1;
    // 28 bytes location left as zeros
    jpeg.copy(complete, 36);

    const assembler = new SubpackageAssembler(2);
    expect(assembler.add(1, complete.subarray(0, 20))).toBe(false);
    expect(assembler.add(2, complete.subarray(20))).toBe(true);

    const upload = parseMultimediaUpload(assembler.assemble());
    expect(upload.multimediaId).toBe(99);
    expect(upload.mediaData).toEqual(jpeg);

    const ack = buildMultimediaUploadAck(99);
    expect(ack.readUInt32BE(0)).toBe(99);
    expect(ack[4]).toBe(0);
  });
});
