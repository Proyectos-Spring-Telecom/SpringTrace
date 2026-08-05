/** Cabecera fija de 0x0801 antes de los bytes de la imagen. */
const MULTIMEDIA_FIXED_HEADER = 8;
/** Información de posición embebida en 0x0801 (misma base que 0x0200). */
const MULTIMEDIA_LOCATION_LENGTH = 28;
export const MULTIMEDIA_DATA_OFFSET =
  MULTIMEDIA_FIXED_HEADER + MULTIMEDIA_LOCATION_LENGTH;

export interface CameraShootCommand {
  channelId: number;
  shootCommand?: number;
  shootInterval?: number;
  saveFlag?: number;
  resolution?: number;
  quality?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  chromaticity?: number;
}

export interface CameraControlResponse {
  responseSerial: number;
  result: number;
  resultLabel: string;
  multimediaIds: number[];
}

export interface MultimediaUpload {
  multimediaId: number;
  multimediaType: number;
  multimediaFormat: number;
  eventCode: number;
  channelId: number;
  /** Bytes del archivo (JPEG u otro), tras cabecera + ubicación. */
  mediaData: Buffer;
}

const CAMERA_RESULT_LABELS: Record<number, string> = {
  0: 'éxito',
  1: 'fallo',
  2: 'canal no soportado',
};

/** Construye el cuerpo de 0x8801 (control inmediato de cámara). */
export function buildCameraShootBody(options: CameraShootCommand): Buffer {
  const channelId = options.channelId ?? 1;
  const shootCommand = options.shootCommand ?? 1;
  const shootInterval = options.shootInterval ?? 0;
  const saveFlag = options.saveFlag ?? 1;
  const resolution = options.resolution ?? 0;
  const quality = options.quality ?? 5;
  const brightness = options.brightness ?? 0;
  const contrast = options.contrast ?? 0;
  const saturation = options.saturation ?? 0;
  const chromaticity = options.chromaticity ?? 0;

  const body = Buffer.alloc(12);
  body[0] = channelId & 0xff;
  body.writeUInt16BE(shootCommand & 0xffff, 1);
  body.writeUInt16BE(shootInterval & 0xffff, 3);
  body[5] = saveFlag & 0xff;
  body[6] = resolution & 0xff;
  body[7] = quality & 0xff;
  body[8] = brightness & 0xff;
  body[9] = contrast & 0xff;
  body[10] = saturation & 0xff;
  body[11] = chromaticity & 0xff;
  return body;
}

/** Parsea el cuerpo de 0x0805 (respuesta de control de cámara). */
export function parseCameraControlResponse(
  body: Buffer,
): CameraControlResponse {
  if (body.length < 3) {
    throw new Error(`Cuerpo 0x0805 demasiado corto: ${body.length} bytes`);
  }

  const responseSerial = body.readUInt16BE(0);
  const result = body[2];
  const resultLabel = CAMERA_RESULT_LABELS[result] ?? `código ${result}`;
  const multimediaIds: number[] = [];

  if (result === 0) {
    if (body.length < 5) {
      throw new Error('0x0805 éxito sin conteo de multimedia');
    }
    const count = body.readUInt16BE(3);
    const expected = 5 + count * 4;
    if (body.length < expected) {
      throw new Error(
        `0x0805 incompleto: esperados ${count} IDs (${expected} bytes), hay ${body.length}`,
      );
    }
    for (let i = 0; i < count; i++) {
      multimediaIds.push(body.readUInt32BE(5 + i * 4));
    }
  }

  return { responseSerial, result, resultLabel, multimediaIds };
}

/**
 * Parsea el cuerpo COMPLETO reensamblado de 0x0801.
 * Cabecera fija (8) + ubicación (28) + datos multimedia.
 */
export function parseMultimediaUpload(body: Buffer): MultimediaUpload {
  if (body.length < MULTIMEDIA_DATA_OFFSET) {
    throw new Error(
      `Cuerpo 0x0801 demasiado corto: ${body.length} bytes (mínimo ${MULTIMEDIA_DATA_OFFSET})`,
    );
  }

  return {
    multimediaId: body.readUInt32BE(0),
    multimediaType: body[4],
    multimediaFormat: body[5],
    eventCode: body[6],
    channelId: body[7],
    mediaData: Buffer.from(body.subarray(MULTIMEDIA_DATA_OFFSET)),
  };
}

/**
 * Respuesta 0x8800 de éxito: multimediaId + cantidad de retransmisión = 0.
 * Indica que no faltan paquetes.
 */
export function buildMultimediaUploadAck(multimediaId: number): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt32BE(multimediaId >>> 0, 0);
  body[4] = 0;
  return body;
}

/** Ensambla fragmentos de cuerpo JT808 por número de paquete (1-based). */
export class SubpackageAssembler {
  readonly totalPackages: number;
  private readonly packages = new Map<number, Buffer>();

  constructor(totalPackages: number) {
    if (!Number.isInteger(totalPackages) || totalPackages < 1) {
      throw new RangeError('totalPackages inválido');
    }
    this.totalPackages = totalPackages;
  }

  add(packageNo: number, bodyFragment: Buffer): boolean {
    if (packageNo < 1 || packageNo > this.totalPackages) {
      throw new RangeError(
        `packageNo ${packageNo} fuera de rango 1..${this.totalPackages}`,
      );
    }
    this.packages.set(packageNo, Buffer.from(bodyFragment));
    return this.isComplete();
  }

  isComplete(): boolean {
    return this.packages.size >= this.totalPackages;
  }

  receivedCount(): number {
    return this.packages.size;
  }

  /** Concatena los fragmentos en orden 1..N. */
  assemble(): Buffer {
    if (!this.isComplete()) {
      throw new Error(
        `Subpaquetes incompletos: ${this.packages.size}/${this.totalPackages}`,
      );
    }
    const parts: Buffer[] = [];
    for (let i = 1; i <= this.totalPackages; i++) {
      const part = this.packages.get(i);
      if (!part) {
        throw new Error(`Falta el subpaquete ${i}`);
      }
      parts.push(part);
    }
    return Buffer.concat(parts);
  }
}
