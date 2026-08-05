import {
  buildRealtimeVideoControlBody,
  buildRealtimeVideoRequestBody,
  containsJt1078Marker,
  JT1078_FRAME_MARKER,
} from './jt808.video';

describe('JT808/JT1078 video codec', () => {
  it('construye 0x9101 con IP, puerto y stream principal por defecto', () => {
    const body = buildRealtimeVideoRequestBody({
      serverIp: '216.238.70.193',
      tcpPort: 9002,
      udpPort: 0,
      channelId: 1,
      dataType: 1,
    });

    expect(body[0]).toBe(14);
    expect(body.subarray(1, 15).toString('ascii')).toBe('216.238.70.193');
    expect(body.readUInt16BE(15)).toBe(9002);
    expect(body.readUInt16BE(17)).toBe(0);
    expect(body[19]).toBe(1);
    expect(body[20]).toBe(1);
    expect(body[21]).toBe(0);
  });

  it('construye 0x9102 de cierre', () => {
    expect(
      buildRealtimeVideoControlBody({ channelId: 1, controlCmd: 0 }),
    ).toEqual(Buffer.from([1, 0, 0, 0]));
  });

  it('detecta el marcador JT1078 30 31 63 64', () => {
    const packet = Buffer.concat([
      Buffer.from([0xaa]),
      JT1078_FRAME_MARKER,
      Buffer.from([0x01, 0x02]),
    ]);
    expect(containsJt1078Marker(packet)).toBe(true);
    expect(containsJt1078Marker(Buffer.from([0x01, 0x02]))).toBe(false);
  });
});
