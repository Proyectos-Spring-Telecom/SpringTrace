import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/** Message IDs JT808 conocidos (pistas exploratorias, no parseo real). */
const JT808_MESSAGE_IDS: Record<number, string> = {
  0x0100: 'Registro de terminal',
  0x0102: 'Autenticación',
  0x0002: 'Heartbeat',
  0x0200: 'Reporte de posición GPS',
  0x0704: 'Reporte en lote',
};

@Injectable()
export class SnifferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnifferService.name);
  private server: net.Server | null = null;
  private logStream: fs.WriteStream | null = null;
  private readonly port: number;

  constructor(private readonly configService: ConfigService) {
    this.port = this.configService.get<number>('SNIFFER_PORT', 9001);
  }

  onModuleInit(): void {
    const capturasDir = path.resolve(process.cwd(), 'capturas');
    if (!fs.existsSync(capturasDir)) {
      fs.mkdirSync(capturasDir, { recursive: true });
    }

    // Sanitizar ISO para nombres de archivo válidos en Windows (sin ':' ni '.')
    const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(capturasDir, `captura-${isoSafe}.log`);
    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });

    this.writeLog(`=== Sniffer TCP iniciado | puerto=${this.port} | log=${logPath} ===\n`);
    this.logger.log(`Archivo de captura: ${logPath}`);

    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.logger.error(
          `Puerto ${this.port} en uso (EADDRINUSE). Libera el puerto o cambia SNIFFER_PORT.`,
        );
      } else {
        this.logger.error(`Error del servidor TCP sniffer: ${err.message}`);
      }
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(
        `Sniffer TCP escuchando en 0.0.0.0:${this.port} (independiente del HTTP Nest)`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.logger.log('Servidor TCP sniffer cerrado');
        resolve();
      });
      this.server = null;
    });

    if (this.logStream) {
      this.writeLog('=== Sniffer TCP detenido ===\n');
      await new Promise<void>((resolve) => {
        this.logStream!.end(() => resolve());
      });
      this.logStream = null;
    }
  }

  private handleConnection(socket: net.Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const header = `[CONN] Nueva conexión desde ${remote}`;
    this.logger.log(header);
    this.writeLog(`\n${header}\n`);

    socket.on('data', (buffer: Buffer) => {
      const stamp = new Date().toISOString();
      const hint = this.analyzeJt808Hints(buffer);
      const dump = this.toHexDump(buffer);

      const block = [
        `--- ${stamp} | ${remote} | ${buffer.length} byte(s) ---`,
        hint,
        dump,
        '',
      ].join('\n');

      this.logger.log(`\n${block}`);
      this.writeLog(`${block}\n`);
    });

    socket.on('close', () => {
      const msg = `[CLOSE] Conexión cerrada: ${remote}`;
      this.logger.log(msg);
      this.writeLog(`${msg}\n`);
    });

    socket.on('error', (err: Error) => {
      const msg = `[ERROR] Socket ${remote}: ${err.message}`;
      this.logger.error(msg);
      this.writeLog(`${msg}\n`);
    });
  }

  /**
   * Hex dump legible: offset + 16 bytes hex + ASCII imprimible.
   * Ejemplo de fila:
   * 00000000  7e 01 00 00 2b 01 38 36  31 30 37 38 30 36 35 36  |~....+.8610780656|
   */
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
          ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
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

  /**
   * Pistas mínimas JT808: 0x7e ... 0x7e y Message ID big-endian tras el flag inicial.
   * No es un parseo real (no maneja escape 0x7d, body length, checksum, etc.).
   */
  private analyzeJt808Hints(buffer: Buffer): string {
    if (buffer.length === 0) {
      return '[PISTA] Buffer vacío';
    }

    const startsWith7e = buffer[0] === 0x7e;
    const endsWith7e = buffer[buffer.length - 1] === 0x7e;

    if (!startsWith7e || !endsWith7e) {
      return (
        '[PISTA] No empieza y termina con 0x7e → posible otro protocolo, ' +
        'fragmento parcial o trama incompleta'
      );
    }

    if (buffer.length < 3) {
      return '[PISTA] Empieza/termina con 0x7e pero es demasiado corta para Message ID';
    }

    const messageId = buffer.readUInt16BE(1);
    const known = JT808_MESSAGE_IDS[messageId];
    const idHex = `0x${messageId.toString(16).padStart(4, '0')}`;

    if (known) {
      return `[PISTA] Parece trama JT808 | Message ID ${idHex} (${known})`;
    }

    return `[PISTA] Parece trama JT808 | Message ID ${idHex} (desconocido)`;
  }

  private writeLog(text: string): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(text);
    }
  }
}
