import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export type CaptureDirection = 'RX' | 'TX';

export interface CaptureFrameMeta {
  direction: CaptureDirection;
  remote: string;
  terminalId?: string;
  messageId: number;
  messageLabel: string;
  frame: Buffer;
  /** false para cargas grandes (p. ej. 0x0801): conserva cabecera y tamaño. */
  includeHexDump?: boolean;
}

@Injectable()
export class CaptureLoggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptureLoggerService.name);
  private readonly enabled: boolean;
  private readonly captureDir: string;
  private stream: fs.WriteStream | null = null;
  private currentDateKey: string | null = null;
  private currentFilePath: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      this.configService.get<boolean>('GATEWAY_CAPTURE_ENABLED', true) ?? true;
    const configuredDir =
      this.configService.get<string>('GATEWAY_CAPTURE_DIR') ?? './capturas';
    this.captureDir = path.isAbsolute(configuredDir)
      ? configuredDir
      : path.resolve(process.cwd(), configuredDir);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Captura a archivo desactivada (GATEWAY_CAPTURE_ENABLED=false)',
      );
      return;
    }

    try {
      fs.mkdirSync(this.captureDir, { recursive: true });
      this.openStreamForToday();
      this.logger.log(`Captura a archivo activa: ${this.captureDir}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo iniciar captura a archivo: ${detail}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeStream();
  }

  /**
   * Escribe de forma asíncrona. Nunca lanza hacia el caller:
   * un fallo de disco solo se reporta por consola.
   */
  logFrame(meta: CaptureFrameMeta): void {
    if (!this.enabled) {
      return;
    }

    try {
      this.ensureStreamForToday();
      if (!this.stream || this.stream.destroyed || !this.stream.writable) {
        return;
      }

      const block = this.formatBlock(meta);
      this.stream.write(block, (error?: Error | null) => {
        if (error) {
          this.logger.error(
            `Error al escribir captura JT808: ${error.message}`,
          );
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error de captura JT808: ${detail}`);
    }
  }

  private formatBlock(meta: CaptureFrameMeta): string {
    const stamp = new Date().toISOString();
    const terminal = meta.terminalId ?? 'desconocido';
    const messageIdHex = `0x${meta.messageId.toString(16).padStart(4, '0')}`;
    const lines = [
      `--- ${stamp} | ${meta.direction} | ${meta.remote} | terminal=${terminal} | ` +
        `messageId=${messageIdHex} (${meta.messageLabel}) | ${meta.frame.length} byte(s) ---`,
    ];

    if (meta.includeHexDump === false) {
      lines.push('[hex omitido: carga multimedia]');
    } else {
      lines.push(this.toHexDump(meta.frame));
    }

    lines.push('', '');
    return lines.join('\n');
  }

  /** Hex dump: offset + 16 bytes hex + ASCII imprimible. */
  private toHexDump(buffer: Buffer): string {
    const lines: string[] = [];
    const rowSize = 16;

    for (let offset = 0; offset < buffer.length; offset += rowSize) {
      const slice = buffer.subarray(offset, offset + rowSize);
      const left: string[] = [];
      const right: string[] = [];
      let ascii = '';

      for (let i = 0; i < rowSize; i++) {
        if (i < slice.length) {
          const byte = slice[i];
          const hex = byte.toString(16).padStart(2, '0');
          if (i < 8) left.push(hex);
          else right.push(hex);
          ascii +=
            byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
        } else {
          if (i < 8) left.push('  ');
          else right.push('  ');
        }
      }

      const offsetStr = offset.toString(16).padStart(8, '0');
      lines.push(
        `${offsetStr}  ${left.join(' ')}  ${right.join(' ')}  |${ascii}|`,
      );
    }

    return lines.join('\n');
  }

  private ensureStreamForToday(): void {
    const dateKey = this.todayKey();
    if (
      this.stream &&
      this.currentDateKey === dateKey &&
      this.stream.writable
    ) {
      return;
    }

    this.openStreamForToday();
  }

  private openStreamForToday(): void {
    const dateKey = this.todayKey();
    const filePath = path.join(this.captureDir, `captura-${dateKey}.log`);

    if (this.stream) {
      // Rotación diaria: cerrar el stream anterior sin await (arranque/escritura).
      this.stream.end();
      this.stream = null;
    }

    fs.mkdirSync(this.captureDir, { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.currentDateKey = dateKey;
    this.currentFilePath = filePath;

    this.stream.on('error', (error: Error) => {
      this.logger.error(`Error del stream de captura: ${error.message}`);
    });

    this.logger.log(`Archivo de captura: ${filePath}`);
  }

  private todayKey(): string {
    // YYYY-MM-DD en hora local del servidor
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private async closeStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    this.currentDateKey = null;

    if (!stream) {
      return;
    }

    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });

    if (this.currentFilePath) {
      this.logger.log(`Captura a archivo cerrada: ${this.currentFilePath}`);
    }
    this.currentFilePath = null;
  }
}
