export interface RealtimeVideoRequest {
  serverIp: string;
  tcpPort: number;
  udpPort?: number;
  channelId?: number;
  /** 0=audio+video, 1=video, 2=intercom, 3=monitor, 4=center broadcast */
  dataType?: number;
  /** 0=main, 1=sub */
  streamType?: number;
}

export interface RealtimeVideoControl {
  channelId?: number;
  /** 0=cerrar, 1=cambiar stream, 2=pausar, 3=reanudar, 4=cerrar intercom */
  controlCmd?: number;
  /** 0=cerrar AV, 1=solo audio, 2=solo video (cuando controlCmd=0) */
  closeType?: number;
  /** 0=main, 1=sub (cuando controlCmd=1) */
  switchStreamType?: number;
}

/** Marcador de frame JT1078: "01cd" → 0x30 0x31 0x63 0x64 */
export const JT1078_FRAME_MARKER = Buffer.from([0x30, 0x31, 0x63, 0x64]);

/** Construye el cuerpo de 0x9101 (solicitud de video en tiempo real). */
export function buildRealtimeVideoRequestBody(
  options: RealtimeVideoRequest,
): Buffer {
  const serverIp = options.serverIp.trim();
  if (!serverIp) {
    throw new Error('serverIp es obligatorio para 0x9101');
  }
  if (serverIp.length > 255) {
    throw new RangeError('serverIp excede 255 caracteres');
  }

  const tcpPort = options.tcpPort;
  const udpPort = options.udpPort ?? 0;
  const channelId = options.channelId ?? 1;
  const dataType = options.dataType ?? 1;
  const streamType = options.streamType ?? 0;

  if (!Number.isInteger(tcpPort) || tcpPort < 0 || tcpPort > 0xffff) {
    throw new RangeError('tcpPort inválido');
  }

  const ipBuf = Buffer.from(serverIp, 'ascii');
  const body = Buffer.alloc(1 + ipBuf.length + 2 + 2 + 1 + 1 + 1);
  let offset = 0;
  body[offset++] = ipBuf.length;
  ipBuf.copy(body, offset);
  offset += ipBuf.length;
  body.writeUInt16BE(tcpPort, offset);
  offset += 2;
  body.writeUInt16BE(udpPort, offset);
  offset += 2;
  body[offset++] = channelId & 0xff;
  body[offset++] = dataType & 0xff;
  body[offset++] = streamType & 0xff;
  return body;
}

/**
 * Construye el cuerpo de 0x9102 (control de transmisión en tiempo real).
 * Por defecto: cerrar AV en el canal indicado.
 */
export function buildRealtimeVideoControlBody(
  options: RealtimeVideoControl = {},
): Buffer {
  const channelId = options.channelId ?? 1;
  const controlCmd = options.controlCmd ?? 0;
  const closeType = options.closeType ?? 0;
  const switchStreamType = options.switchStreamType ?? 0;

  const body = Buffer.alloc(4);
  body[0] = channelId & 0xff;
  body[1] = controlCmd & 0xff;
  body[2] = closeType & 0xff;
  body[3] = switchStreamType & 0xff;
  return body;
}

export function containsJt1078Marker(chunk: Buffer): boolean {
  return chunk.indexOf(JT1078_FRAME_MARKER) >= 0;
}

export function headerHexPreview(chunk: Buffer, maxBytes = 40): string {
  const slice = chunk.subarray(0, Math.min(maxBytes, chunk.length));
  return slice.toString('hex').replace(/(..)/g, '$1 ').trim();
}
