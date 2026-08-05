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
import { containsJt1078Marker, headerHexPreview } from './jt808.video';

const SUMMARY_EVERY_PACKETS = 25;
const MAX_PENDING_RAW_BYTES = 1024 * 1024;

export interface MediaServerStatus {
  listening: boolean;
  port: number;
  activeConnection: boolean;
  remoteAddress: string | null;
  terminalIdHint: string | null;
  packets: number;
  bytes: number;
  jt1078MarkerSeen: boolean;
  rawFilePath: string | null;
  waitingForConnection: boolean;
  lastPacketAt: string | null;
}

@Injectable()
export class MediaServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaServerService.name);
  private readonly port: number;
  private readonly videoDir: string;
  private readonly connectTimeoutMs: number;
  private server: net.Server | null = null;
  private activeSocket: net.Socket | null = null;
  private rawStream: fs.WriteStream | null = null;
  private rawFilePath: string | null = null;
  private packets = 0;
  private bytes = 0;
  private jt1078MarkerSeen = false;
  private remoteAddress: string | null = null;
  private terminalIdHint: string | null = null;
  private lastPacketAt: Date | null = null;
  private waitingForConnection = false;
  private connectTimeout: NodeJS.Timeout | null = null;
  private markerCarry = Buffer.alloc(0);
  private pendingRawChunks: Buffer[] = [];
  private pendingRawBytes = 0;
  private onConnected: (() => void) | null = null;
  private onConnectionTimeout: (() => void) | null = null;

  constructor(private readonly configService: ConfigService) {
    this.port =
      this.configService.get<number>('GATEWAY_MEDIA_PORT', 9002) ?? 9002;
    this.connectTimeoutMs =
      this.configService.get<number>('GATEWAY_VIDEO_TIMEOUT', 30000) ?? 30000;
    const configured =
      this.configService.get<string>('GATEWAY_VIDEO_DIR') ?? './video';
    this.videoDir = path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }

  onModuleInit(): void {
    try {
      fs.mkdirSync(this.videoDir, { recursive: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo crear carpeta de video: ${detail}`);
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        this.logger.error(
          `Puerto media ${this.port} en uso (EADDRINUSE). Cambia GATEWAY_MEDIA_PORT.`,
        );
        return;
      }
      this.logger.error(`Error del servidor media TCP: ${error.message}`);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(
        `Servidor media JT1078 escuchando en 0.0.0.0:${this.port}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.clearConnectTimeout();
    this.closeActiveSocket('gateway destroy');
    await this.closeRawStream();

    const server = this.server;
    this.server = null;
    if (!server || !server.listening) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        this.logger.log('Servidor media JT1078 cerrado');
        resolve();
      });
    });
  }

  /** Armar espera de conexión tras enviar 0x9101. */
  expectConnection(
    terminalId: string,
    onConnected?: () => void,
    onTimeout?: () => void,
  ): void {
    this.terminalIdHint = terminalId;
    this.waitingForConnection = true;
    this.onConnected = onConnected ?? null;
    this.onConnectionTimeout = onTimeout ?? null;
    this.clearConnectTimeout();

    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.waitingForConnection = false;
      this.logger.log(
        `Conexión media ya activa al solicitar video: terminal=${terminalId}`,
      );
      const callback = this.onConnected;
      this.onConnected = null;
      this.onConnectionTimeout = null;
      callback?.();
      return;
    }

    this.connectTimeout = setTimeout(() => {
      this.connectTimeout = null;
      if (this.activeSocket && !this.activeSocket.destroyed) {
        this.waitingForConnection = false;
        return;
      }
      this.waitingForConnection = false;
      this.logger.warn(
        `La cámara no inició transmisión de video en ${this.connectTimeoutMs}ms ` +
          `(terminal=${terminalId}): posible no soporte JT1078, problema de ` +
          `ancho de banda 4G o puerto ${this.port} no accesible.`,
      );
      const callback = this.onConnectionTimeout;
      this.onConnected = null;
      this.onConnectionTimeout = null;
      callback?.();
    }, this.connectTimeoutMs);
  }

  stopExpecting(): void {
    this.clearConnectTimeout();
    this.waitingForConnection = false;
    this.onConnected = null;
    this.onConnectionTimeout = null;
  }

  /** Cierra la conexión media activa (si existe) y el archivo raw. */
  async stopCapture(reason: string): Promise<void> {
    this.stopExpecting();
    this.closeActiveSocket(reason);
    await this.closeRawStream();
  }

  getStatus(): MediaServerStatus {
    return {
      listening: this.server?.listening ?? false,
      port: this.port,
      activeConnection:
        this.activeSocket !== null && !this.activeSocket.destroyed,
      remoteAddress: this.remoteAddress,
      terminalIdHint: this.terminalIdHint,
      packets: this.packets,
      bytes: this.bytes,
      jt1078MarkerSeen: this.jt1078MarkerSeen,
      rawFilePath: this.rawFilePath,
      waitingForConnection: this.waitingForConnection,
      lastPacketAt: this.lastPacketAt?.toISOString() ?? null,
    };
  }

  private handleConnection(socket: net.Socket): void {
    const remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`;
    this.logger.log(`Conexión MEDIA abierta desde ${remote}`);

    if (this.activeSocket && this.activeSocket !== socket) {
      this.logger.warn(
        `Reemplazando conexión media anterior ${this.remoteAddress} por ${remote}`,
      );
      this.activeSocket.destroy();
    }

    this.activeSocket = socket;
    this.remoteAddress = remote;
    this.waitingForConnection = false;
    this.clearConnectTimeout();
    const connectedCallback = this.onConnected;
    this.onConnected = null;
    this.onConnectionTimeout = null;
    this.packets = 0;
    this.bytes = 0;
    this.jt1078MarkerSeen = false;
    this.lastPacketAt = null;
    this.markerCarry = Buffer.alloc(0);
    this.pendingRawChunks = [];
    this.pendingRawBytes = 0;
    void this.openRawStream();
    connectedCallback?.();

    socket.on('data', (chunk: Buffer) => this.onData(chunk));

    socket.on('close', () => {
      this.logger.log(
        `Conexión MEDIA cerrada: ${remote}, packets=${this.packets}, ` +
          `bytes=${this.bytes}, jt1078=${this.jt1078MarkerSeen}`,
      );
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this.remoteAddress = null;
        void this.closeRawStream();
      }
    });

    socket.on('error', (error: Error) => {
      this.logger.error(`Error MEDIA socket ${remote}: ${error.message}`);
    });
  }

  private onData(chunk: Buffer): void {
    this.packets += 1;
    this.bytes += chunk.length;
    this.lastPacketAt = new Date();

    const markerProbe = Buffer.concat([this.markerCarry, chunk]);
    const hasMarker = containsJt1078Marker(markerProbe);
    this.markerCarry = markerProbe.subarray(
      Math.max(0, markerProbe.length - 3),
    );
    if (hasMarker) {
      this.jt1078MarkerSeen = true;
    }

    const preview = headerHexPreview(chunk, 40);
    this.logger.log(
      `MEDIA pkt#${this.packets} bytes=${chunk.length} ` +
        `jt1078Marker=${hasMarker} header=${preview}`,
    );

    if (
      this.rawStream &&
      !this.rawStream.destroyed &&
      this.rawStream.writable
    ) {
      this.rawStream.write(chunk, (error?: Error | null) => {
        if (error) {
          this.logger.error(`Error escribiendo raw video: ${error.message}`);
        }
      });
    } else {
      // Conserva los primeros chunks mientras se termina de rotar/abrir el stream.
      if (this.pendingRawBytes + chunk.length <= MAX_PENDING_RAW_BYTES) {
        this.pendingRawChunks.push(Buffer.from(chunk));
        this.pendingRawBytes += chunk.length;
      }
    }

    if (this.packets % SUMMARY_EVERY_PACKETS === 0) {
      this.logger.log(
        `MEDIA resumen: packets=${this.packets}, bytes=${this.bytes}, ` +
          `jt1078MarkerSeen=${this.jt1078MarkerSeen}, file=${this.rawFilePath}`,
      );
    }
  }

  private async openRawStream(): Promise<void> {
    await this.closeRawStream();
    try {
      fs.mkdirSync(this.videoDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const terminal = this.terminalIdHint ?? 'unknown';
      const fileName = `raw-${terminal}-${stamp}.bin`;
      this.rawFilePath = path.join(this.videoDir, fileName);
      this.rawStream = fs.createWriteStream(this.rawFilePath, { flags: 'a' });
      this.rawStream.on('error', (error: Error) => {
        this.logger.error(`Error stream raw video: ${error.message}`);
      });
      for (const chunk of this.pendingRawChunks.splice(0)) {
        this.rawStream.write(chunk);
      }
      this.pendingRawBytes = 0;
      this.logger.log(`Captura raw video: ${this.rawFilePath}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo abrir archivo raw video: ${detail}`);
      this.rawStream = null;
      this.rawFilePath = null;
      this.pendingRawChunks = [];
      this.pendingRawBytes = 0;
    }
  }

  private async closeRawStream(): Promise<void> {
    const stream = this.rawStream;
    const closedPath = this.rawFilePath;
    this.rawStream = null;
    if (!stream) {
      return;
    }
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
    if (closedPath) {
      this.logger.log(
        `Raw video cerrado: ${closedPath} (packets=${this.packets}, bytes=${this.bytes})`,
      );
    }
  }

  private closeActiveSocket(reason: string): void {
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.logger.log(`Cerrando conexión media (${reason})`);
      this.activeSocket.destroy();
    }
    this.activeSocket = null;
    this.remoteAddress = null;
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }
}
