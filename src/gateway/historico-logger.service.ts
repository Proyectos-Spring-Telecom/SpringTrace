import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { Jt808Location } from './jt808.location';

export interface HistoricoLocationMeta {
  remote: string;
  terminalId: string;
  location: Jt808Location;
}

@Injectable()
export class HistoricoLoggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoricoLoggerService.name);
  private readonly enabled: boolean;
  private readonly historicoDir: string;
  private stream: fs.WriteStream | null = null;
  private currentDateKey: string | null = null;
  private currentFilePath: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      this.configService.get<boolean>('GATEWAY_HISTORICO_ENABLED', true) ??
      true;
    const configuredDir =
      this.configService.get<string>('GATEWAY_HISTORICO_DIR') ?? './historico';
    this.historicoDir = path.isAbsolute(configuredDir)
      ? configuredDir
      : path.resolve(process.cwd(), configuredDir);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Histórico de posiciones desactivado (GATEWAY_HISTORICO_ENABLED=false)',
      );
      return;
    }

    try {
      fs.mkdirSync(this.historicoDir, { recursive: true });
      this.openStreamForToday();
      this.logger.log(`Histórico de posiciones activo: ${this.historicoDir}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo iniciar histórico a archivo: ${detail}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeStream();
  }

  /** Escritura asíncrona; errores de disco solo a consola. */
  logLocation(meta: HistoricoLocationMeta): void {
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
            `Error al escribir histórico 0x0200: ${error.message}`,
          );
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error de histórico 0x0200: ${detail}`);
    }
  }

  private formatBlock(meta: HistoricoLocationMeta): string {
    const stamp = new Date().toISOString();
    const loc = meta.location;
    const tlv =
      loc.extraTlv.length === 0
        ? 'none'
        : loc.extraTlv
            .map(
              (item) =>
                `0x${item.id.toString(16).padStart(2, '0')}:${item.length}b`,
            )
            .join(',');

    return [
      `[${stamp}] terminal=${meta.terminalId} ip=${meta.remote}`,
      `  lat=${loc.latitude.toFixed(6)} lng=${loc.longitude.toFixed(6)} ` +
        `alt=${loc.altitude}m speed=${loc.speedKmh.toFixed(1)}km/h ` +
        `dir=${loc.direction}° validPos=${loc.positionValid}`,
      `  timeUTC8=${loc.timeUtc8} timeMX=${loc.timeLocalMx}`,
      `  alarm=0x${loc.alarmRaw.toString(16).padStart(8, '0')} ` +
        `status=0x${loc.statusRaw.toString(16).padStart(8, '0')} tlv=${tlv}`,
      `  bodyHex=${loc.rawHex}`,
      '',
    ].join('\n');
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
    const filePath = path.join(this.historicoDir, `historico-${dateKey}.log`);

    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    fs.mkdirSync(this.historicoDir, { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.currentDateKey = dateKey;
    this.currentFilePath = filePath;

    this.stream.on('error', (error: Error) => {
      this.logger.error(`Error del stream de histórico: ${error.message}`);
    });

    this.logger.log(`Archivo de histórico: ${filePath}`);
  }

  private todayKey(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private async closeStream(): Promise<void> {
    const stream = this.stream;
    const closedPath = this.currentFilePath;
    this.stream = null;
    this.currentDateKey = null;
    this.currentFilePath = null;

    if (!stream) {
      return;
    }

    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });

    if (closedPath) {
      this.logger.log(`Histórico a archivo cerrado: ${closedPath}`);
    }
  }
}
