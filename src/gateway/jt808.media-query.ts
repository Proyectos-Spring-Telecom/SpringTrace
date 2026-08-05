const STORED_MEDIA_ITEM_LENGTH = 35;

export interface TerminalGeneralResponse {
  responseSerial: number;
  responseMessageId: number;
  result: number;
  resultLabel: string;
}

export interface StoredMediaItem {
  multimediaId: number;
  mediaType: number;
  channelId: number;
  eventCode: number;
  locationRawHex: string;
}

export interface StoredMediaQueryResponse {
  responseSerial: number;
  totalItems: number;
  items: StoredMediaItem[];
}

const GENERAL_RESULT_LABELS: Record<number, string> = {
  0: 'éxito',
  1: 'fallo',
  2: 'mensaje erróneo',
  3: 'no soportado',
};

/** Parsea 0x0001: respuesta genérica del terminal. */
export function parseTerminalGeneralResponse(
  body: Buffer,
): TerminalGeneralResponse {
  if (body.length < 5) {
    throw new Error(`Cuerpo 0x0001 demasiado corto: ${body.length} bytes`);
  }

  const responseSerial = body.readUInt16BE(0);
  const responseMessageId = body.readUInt16BE(2);
  const result = body[4];

  return {
    responseSerial,
    responseMessageId,
    result,
    resultLabel: GENERAL_RESULT_LABELS[result] ?? `código ${result}`,
  };
}

/**
 * Construye 0x8802 para consultar todas las imágenes almacenadas:
 * tipo imagen, todos los canales/eventos y rango temporal sin límites.
 */
export function buildStoredMediaQueryBody(): Buffer {
  return Buffer.alloc(15, 0);
}

/** Parsea 0x0802: respuesta de consulta de multimedia almacenado. */
export function parseStoredMediaQueryResponse(
  body: Buffer,
): StoredMediaQueryResponse {
  if (body.length < 4) {
    throw new Error(`Cuerpo 0x0802 demasiado corto: ${body.length} bytes`);
  }

  const responseSerial = body.readUInt16BE(0);
  const totalItems = body.readUInt16BE(2);
  const expectedLength = 4 + totalItems * STORED_MEDIA_ITEM_LENGTH;
  if (body.length < expectedLength) {
    throw new Error(
      `0x0802 incompleto: totalItems=${totalItems}, ` +
        `esperados=${expectedLength} bytes, recibidos=${body.length}`,
    );
  }

  const items: StoredMediaItem[] = [];
  for (let index = 0; index < totalItems; index++) {
    const offset = 4 + index * STORED_MEDIA_ITEM_LENGTH;
    items.push({
      multimediaId: body.readUInt32BE(offset),
      mediaType: body[offset + 4],
      channelId: body[offset + 5],
      eventCode: body[offset + 6],
      locationRawHex: body
        .subarray(offset + 7, offset + STORED_MEDIA_ITEM_LENGTH)
        .toString('hex'),
    });
  }

  return { responseSerial, totalItems, items };
}
