/** Cuerpo mínimo 0x0200 JT808:2011 (sin TLV opcionales). */
const LOCATION_BASIC_LENGTH = 28;

/** Status bit1: posicionamiento válido. */
const STATUS_BIT_POSITIONED = 1 << 1;
/** Status bit2: 1 = latitud Sur. */
const STATUS_BIT_SOUTH = 1 << 2;
/** Status bit3: 1 = longitud Oeste. */
const STATUS_BIT_WEST = 1 << 3;

export interface Jt808TlvHint {
  id: number;
  length: number;
}

export interface Jt808Location {
  alarmRaw: number;
  statusRaw: number;
  latitude: number;
  longitude: number;
  altitude: number;
  speedKmh: number;
  direction: number;
  /** Fecha/hora del terminal en UTC+8 (China), legible. */
  timeUtc8: string;
  /** Misma marca convertida a America/Mexico_City. */
  timeLocalMx: string;
  positionValid: boolean;
  /** Hex del cuerpo completo (espaciado cada 4 bytes para lectura). */
  rawHex: string;
  /** TLV opcionales tolerantes: solo id + longitud. */
  extraTlv: Jt808TlvHint[];
}

/**
 * Parsea el cuerpo de un mensaje JT/T 808:2011 0x0200 (reporte de posición).
 * No interpreta alarmas ni TLV en profundidad; es tolerante a bytes opcionales.
 */
export function parseLocation(body: Buffer): Jt808Location {
  if (body.length < LOCATION_BASIC_LENGTH) {
    throw new Error(
      `Cuerpo 0x0200 demasiado corto: ${body.length} bytes (mínimo ${LOCATION_BASIC_LENGTH})`,
    );
  }

  const alarmRaw = body.readUInt32BE(0);
  const statusRaw = body.readUInt32BE(4);
  const latRaw = body.readUInt32BE(8);
  const lngRaw = body.readUInt32BE(12);
  const altitude = body.readUInt16BE(16);
  const speedRaw = body.readUInt16BE(18);
  const direction = body.readUInt16BE(20);
  const timeBytes = body.subarray(22, 28);

  const positionValid = (statusRaw & STATUS_BIT_POSITIONED) !== 0;
  let latitude = latRaw / 1_000_000;
  let longitude = lngRaw / 1_000_000;
  if (statusRaw & STATUS_BIT_SOUTH) {
    latitude = -latitude;
  }
  if (statusRaw & STATUS_BIT_WEST) {
    longitude = -longitude;
  }

  const speedKmh = Math.round((speedRaw / 10) * 10) / 10;
  const { timeUtc8, timeLocalMx } = parseTerminalTime(timeBytes);
  const extraTlv = parseOptionalTlv(body.subarray(LOCATION_BASIC_LENGTH));

  return {
    alarmRaw,
    statusRaw,
    latitude,
    longitude,
    altitude,
    speedKmh,
    direction,
    timeUtc8,
    timeLocalMx,
    positionValid,
    rawHex: formatBodyHex(body),
    extraTlv,
  };
}

function parseBcdByte(byte: number): number {
  return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

/**
 * BCD YYMMDDhhmmss en hora UTC+8 (estándar JT808).
 * Devuelve cadenas legibles en China y en America/Mexico_City.
 */
function parseTerminalTime(bcd: Buffer): {
  timeUtc8: string;
  timeLocalMx: string;
} {
  if (bcd.length !== 6) {
    throw new Error('Campo Time del 0x0200 debe tener 6 bytes BCD');
  }

  const year = 2000 + parseBcdByte(bcd[0]);
  const month = parseBcdByte(bcd[1]);
  const day = parseBcdByte(bcd[2]);
  const hour = parseBcdByte(bcd[3]);
  const minute = parseBcdByte(bcd[4]);
  const second = parseBcdByte(bcd[5]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(
      `Hora BCD inválida: ${year}-${month}-${day} ${hour}:${minute}:${second}`,
    );
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const timeUtc8 = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;

  // Instant UTC = componentes China (UTC+8) menos 8 horas.
  const chinaAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const instant = new Date(chinaAsUtcMs - 8 * 60 * 60 * 1000);
  const timeLocalMx = formatInTimeZone(instant, 'America/Mexico_City');

  return { timeUtc8, timeLocalMx };
}

function formatInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';

  // en-CA suele dar YYYY-MM-DD; hora en 24h.
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function parseOptionalTlv(extra: Buffer): Jt808TlvHint[] {
  const items: Jt808TlvHint[] = [];
  let offset = 0;

  while (offset + 2 <= extra.length) {
    const id = extra[offset];
    const length = extra[offset + 1];
    if (offset + 2 + length > extra.length) {
      break;
    }
    items.push({ id, length });
    offset += 2 + length;
  }

  return items;
}

function formatBodyHex(body: Buffer): string {
  const hex = body.toString('hex');
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    chunks.push(hex.slice(i, i + 8));
  }
  return chunks.join(' ');
}
