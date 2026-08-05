const FRAME_DELIMITER = 0x7e;
const ESCAPE_MARKER = 0x7d;
const HEADER_LENGTH_2011 = 12;
const MAX_BODY_LENGTH = 0x03ff;

export interface Jt808Header {
  messageId: number;
  bodyLength: number;
  terminalId: string;
  serialNumber: number;
  body: Buffer;
}

/**
 * Deshace la transparencia JT/T 808 sobre los bytes internos de una trama.
 * El buffer no debe incluir los delimitadores 0x7e.
 */
export function unescape(buffer: Buffer): Buffer {
  const result: number[] = [];

  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index];
    if (byte !== ESCAPE_MARKER) {
      result.push(byte);
      continue;
    }

    if (index + 1 >= buffer.length) {
      throw new Error('Secuencia de escape JT808 incompleta');
    }

    const escapedByte = buffer[++index];
    if (escapedByte === 0x01) {
      result.push(ESCAPE_MARKER);
    } else if (escapedByte === 0x02) {
      result.push(FRAME_DELIMITER);
    } else {
      throw new Error(
        `Secuencia de escape JT808 inválida: 0x7d${escapedByte.toString(16).padStart(2, '0')}`,
      );
    }
  }

  return Buffer.from(result);
}

/**
 * Aplica transparencia JT/T 808 sobre los bytes internos de una trama.
 * El buffer no debe incluir los delimitadores 0x7e.
 */
export function escape(buffer: Buffer): Buffer {
  const result: number[] = [];

  for (const byte of buffer) {
    if (byte === FRAME_DELIMITER) {
      result.push(ESCAPE_MARKER, 0x02);
    } else if (byte === ESCAPE_MARKER) {
      result.push(ESCAPE_MARKER, 0x01);
    } else {
      result.push(byte);
    }
  }

  return Buffer.from(result);
}

/** Calcula el XOR en el intervalo [start, end). */
export function calcChecksum(
  buffer: Buffer,
  start = 0,
  end = buffer.length,
): number {
  if (start < 0 || end < start || end > buffer.length) {
    throw new RangeError('Rango inválido para calcular el checksum');
  }

  let checksum = 0;
  for (let index = start; index < end; index++) {
    checksum ^= buffer[index];
  }
  return checksum;
}

/**
 * Parsea un mensaje JT/T 808:2011 ya des-escapado y sin delimitadores.
 * Puede recibir header+cuerpo o header+cuerpo+checksum.
 */
export function parseHeader(buffer: Buffer): Jt808Header {
  if (buffer.length < HEADER_LENGTH_2011) {
    throw new Error(
      `Mensaje JT808 demasiado corto: ${buffer.length} bytes; se requieren al menos ${HEADER_LENGTH_2011}`,
    );
  }

  const messageId = buffer.readUInt16BE(0);
  const bodyProperties = buffer.readUInt16BE(2);
  const bodyLength = bodyProperties & MAX_BODY_LENGTH;
  const encryptionType = (bodyProperties >> 10) & 0x07;
  const hasSubpackages = (bodyProperties & 0x2000) !== 0;

  if (encryptionType !== 0) {
    throw new Error(`Cifrado JT808 no soportado: tipo ${encryptionType}`);
  }
  if (hasSubpackages) {
    throw new Error('Subpaquetes JT808 no soportados');
  }

  const expectedLength = HEADER_LENGTH_2011 + bodyLength;
  if (buffer.length < expectedLength) {
    throw new Error(
      `Cuerpo JT808 incompleto: esperado ${bodyLength}, disponible ${Math.max(0, buffer.length - HEADER_LENGTH_2011)}`,
    );
  }

  const terminalId = buffer.subarray(4, 10).toString('hex');
  const serialNumber = buffer.readUInt16BE(10);
  const body = Buffer.from(buffer.subarray(HEADER_LENGTH_2011, expectedLength));

  return {
    messageId,
    bodyLength,
    terminalId,
    serialNumber,
    body,
  };
}

/** Construye una trama JT/T 808:2011 completa, escapada y delimitada. */
export function buildMessage(
  messageId: number,
  terminalId: string,
  serialNumber: number,
  body: Buffer,
): Buffer {
  if (!Number.isInteger(messageId) || messageId < 0 || messageId > 0xffff) {
    throw new RangeError('messageId debe ser un entero de 16 bits');
  }
  if (!/^\d{12}$/.test(terminalId)) {
    throw new Error('terminalId debe contener exactamente 12 dígitos BCD');
  }
  if (
    !Number.isInteger(serialNumber) ||
    serialNumber < 0 ||
    serialNumber > 0xffff
  ) {
    throw new RangeError('serialNumber debe ser un entero de 16 bits');
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new RangeError(
      `El cuerpo JT808 excede el máximo de ${MAX_BODY_LENGTH} bytes`,
    );
  }

  const header = Buffer.alloc(HEADER_LENGTH_2011);
  header.writeUInt16BE(messageId, 0);
  header.writeUInt16BE(body.length, 2);
  Buffer.from(terminalId, 'hex').copy(header, 4);
  header.writeUInt16BE(serialNumber, 10);

  const payload = Buffer.concat([header, body]);
  const checksum = Buffer.from([calcChecksum(payload)]);
  const escapedPayload = escape(Buffer.concat([payload, checksum]));

  return Buffer.concat([
    Buffer.from([FRAME_DELIMITER]),
    escapedPayload,
    Buffer.from([FRAME_DELIMITER]),
  ]);
}

/**
 * Ensambla tramas por conexión. Tolera datos partidos, varias tramas por chunk,
 * delimitadores consecutivos y ruido anterior al primer 0x7e.
 */
export class Jt808FrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) {
      return [];
    }

    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];

    while (this.pending.length > 0) {
      const start = this.pending.indexOf(FRAME_DELIMITER);
      if (start < 0) {
        this.pending = Buffer.alloc(0);
        break;
      }

      if (start > 0) {
        this.pending = this.pending.subarray(start);
      }

      const end = this.pending.indexOf(FRAME_DELIMITER, 1);
      if (end < 0) {
        break;
      }

      const frame = this.pending.subarray(1, end);
      this.pending = this.pending.subarray(end);

      if (frame.length > 0) {
        frames.push(Buffer.from(frame));
      }
    }

    return frames;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}
