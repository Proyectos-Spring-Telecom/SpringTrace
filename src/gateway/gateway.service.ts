import {
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { CaptureLoggerService } from './capture-logger.service';
import { HistoricoLoggerService } from './historico-logger.service';
import { parseLocation } from './jt808.location';
import {
  buildStoredMediaQueryBody,
  parseStoredMediaQueryResponse,
  parseTerminalGeneralResponse,
  StoredMediaItem,
} from './jt808.media-query';
import { MediaServerService } from './media-server.service';
import {
  buildCameraShootBody,
  buildMultimediaUploadAck,
  buildStoredMultimediaUploadCommand,
  parseCameraControlResponse,
  parseMultimediaUpload,
  SubpackageAssembler,
} from './jt808.multimedia';
import {
  buildRealtimeVideoControlBody,
  buildRealtimeVideoRequestBody,
} from './jt808.video';
import {
  buildMessage,
  calcChecksum,
  Jt808FrameDecoder,
  Jt808Header,
  parseHeader,
  unescape as unescapeJt808,
} from './jt808.codec';

const MESSAGE_NAMES: Record<number, string> = {
  0x0001: 'Respuesta genérica del terminal',
  0x0002: 'Heartbeat',
  0x0100: 'Registro',
  0x0102: 'Autenticación',
  0x0200: 'Posición GPS',
  0x0704: 'Posiciones en lote',
  0x0801: 'Subida multimedia',
  0x0802: 'Respuesta consulta multimedia',
  0x0805: 'Respuesta control cámara',
  0x8001: 'Respuesta genérica de plataforma',
  0x8100: 'Respuesta de registro',
  0x8800: 'ACK subida multimedia',
  0x8801: 'Control inmediato de cámara',
  0x8802: 'Consulta multimedia almacenado',
  0x8805: 'Solicitar multimedia almacenado',
  0x9101: 'Solicitud video tiempo real',
  0x9102: 'Control transmisión video',
};

interface ConnectionState {
  decoder: Jt808FrameDecoder;
  terminalId?: string;
}

interface QueuedCaptureCommand {
  channelId: number;
  saveFlag: 0 | 1;
  queuedAt: Date;
}

interface PendingCameraCommand {
  terminalId: string;
  channelId: number;
  saveFlag: 0 | 1;
  timeout: NodeJS.Timeout;
}

interface PendingMultimediaUpload {
  terminalId: string;
  multimediaId: number;
  strategy: 'stored-0x8805' | 'immediate';
  status: 'awaiting' | 'receiving';
  timeout: NodeJS.Timeout | null;
  requestedAt: Date;
}

interface PendingMediaQuery {
  serialNumber: number;
  timeout: NodeJS.Timeout;
  resolve: (items: StoredMediaItem[]) => void;
  reject: (error: Error) => void;
}

interface TerminalSession {
  terminalId: string;
  socket: net.Socket | null;
  authenticated: boolean;
  remoteAddress: string | null;
  lastSeen: Date;
  commandQueue: QueuedCaptureCommand[];
  pendingMultimedia: Map<number, PendingMultimediaUpload>;
  storedMedia: StoredMediaItem[];
  pendingMediaQuery: PendingMediaQuery | null;
}

interface PendingBodyAssembly {
  terminalId: string;
  messageId: number;
  serialNumber: number;
  assembler: SubpackageAssembler;
  socket: net.Socket;
}

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayService.name);
  private readonly port: number;
  private readonly debugHex: boolean;
  private readonly fotosDir: string;
  private readonly captureTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly mediaQueryTimeoutMs: number;
  private readonly defaultTerminalId: string;
  private readonly mediaServerIp: string;
  private readonly mediaServerPort: number;
  private readonly tokens = new Map<string, string>();
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private readonly terminalSessions = new Map<string, TerminalSession>();
  private readonly pendingCameraCommands = new Map<
    number,
    PendingCameraCommand
  >();
  private readonly bodyAssemblies = new Map<string, PendingBodyAssembly>();
  private server: net.Server | null = null;
  private platformSerial = 0;
  private lastVideoRequest: {
    terminalId: string;
    channelId: number;
    dataType: number;
    streamType: number;
    platformSerial: number;
    requestedAt: Date;
    durationSeconds: number;
    startedAt?: Date;
    endsAt?: Date;
    stoppedAt?: Date;
    stopReason?: string;
    responseResult?: number;
    responseLabel?: string;
    respondedAt?: Date;
  } | null = null;
  private videoStopTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly captureLogger: CaptureLoggerService,
    private readonly historicoLogger: HistoricoLoggerService,
    private readonly mediaServer: MediaServerService,
  ) {
    this.port = this.configService.get<number>('GATEWAY_PORT', 9001);
    this.debugHex =
      this.configService.get<boolean>('GATEWAY_DEBUG_HEX', false) ?? false;
    this.captureTimeoutMs =
      this.configService.get<number>('GATEWAY_CAPTURE_TIMEOUT_MS', 30000) ??
      30000;
    this.uploadTimeoutMs =
      this.configService.get<number>('GATEWAY_UPLOAD_TIMEOUT', 30000) ?? 30000;
    this.mediaQueryTimeoutMs =
      this.configService.get<number>('GATEWAY_MEDIA_QUERY_TIMEOUT', 15000) ??
      15000;
    this.defaultTerminalId =
      this.configService.get<string>(
        'GATEWAY_DEFAULT_TERMINAL_ID',
        '007773050481',
      ) ?? '007773050481';
    this.mediaServerIp =
      this.configService.get<string>('GATEWAY_MEDIA_IP') ?? '216.238.70.193';
    this.mediaServerPort =
      this.configService.get<number>('GATEWAY_MEDIA_PORT', 9002) ?? 9002;

    const configuredFotos =
      this.configService.get<string>('GATEWAY_FOTOS_DIR') ?? './fotos';
    this.fotosDir = path.isAbsolute(configuredFotos)
      ? configuredFotos
      : path.resolve(process.cwd(), configuredFotos);
  }

  onModuleInit(): void {
    this.getOrCreateSession(this.defaultTerminalId);

    try {
      fs.mkdirSync(this.fotosDir, { recursive: true });
      this.logger.log(`Carpeta de fotos: ${this.fotosDir}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo crear carpeta de fotos: ${detail}`);
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        this.logger.error(
          `El puerto TCP ${this.port} ya está en uso (EADDRINUSE). ` +
            'Libera el puerto o cambia GATEWAY_PORT.',
        );
        return;
      }

      this.logger.error(`Error del servidor gateway TCP: ${error.message}`);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(`Gateway JT808:2011 escuchando en 0.0.0.0:${this.port}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.clearVideoStopTimer();

    for (const pending of this.pendingCameraCommands.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCameraCommands.clear();
    for (const session of this.terminalSessions.values()) {
      for (const pending of session.pendingMultimedia.values()) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
      }
      if (session.pendingMediaQuery) {
        clearTimeout(session.pendingMediaQuery.timeout);
        session.pendingMediaQuery.reject(
          new Error('Gateway detenido durante consulta multimedia'),
        );
        session.pendingMediaQuery = null;
      }
    }
    this.terminalSessions.clear();
    this.bodyAssemblies.clear();

    for (const socket of this.connections.keys()) {
      socket.destroy();
    }
    this.connections.clear();

    const server = this.server;
    this.server = null;
    if (!server || !server.listening) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close((error?: Error) => {
        if (error) {
          this.logger.error(`Error al cerrar el gateway TCP: ${error.message}`);
        } else {
          this.logger.log('Gateway JT808:2011 cerrado');
        }
        resolve();
      });
    });
  }

  /** Envía ahora o encola por terminalId; siempre es aceptada por HTTP. */
  requestPhotoCapture(
    channelId = 2,
    saveFlag: 0 | 1 = 1,
  ): {
    message: string;
    status: 'sent' | 'queued';
    terminalId: string;
    channelId: number;
    saveFlag: 0 | 1;
    strategy: 'stored-0x8805' | 'immediate';
    platformSerial: number | null;
  } {
    const session = this.selectTargetSession();
    const strategy = saveFlag === 1 ? 'stored-0x8805' : 'immediate';

    if (!session.authenticated || !session.socket || session.socket.destroyed) {
      session.commandQueue.push({ channelId, saveFlag, queuedAt: new Date() });
      this.logger.warn(
        `Captura encolada: terminal=${session.terminalId}, canal=${channelId}, ` +
          `saveFlag=${saveFlag}, cola=${session.commandQueue.length}`,
      );

      return {
        message: 'captura encolada; se enviará al autenticarse la cámara',
        status: 'queued',
        terminalId: session.terminalId,
        channelId,
        saveFlag,
        strategy,
        platformSerial: null,
      };
    }

    try {
      const platformSerial = this.sendCaptureCommand(
        session,
        channelId,
        saveFlag,
      );

      return {
        message: 'captura solicitada',
        status: 'sent',
        terminalId: session.terminalId,
        channelId,
        saveFlag,
        strategy,
        platformSerial,
      };
    } catch (error) {
      session.authenticated = false;
      session.commandQueue.push({ channelId, saveFlag, queuedAt: new Date() });
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `No se pudo enviar captura; quedó en cola: terminal=${session.terminalId}, ` +
          `error=${detail}`,
      );
      return {
        message: 'captura encolada; se enviará al autenticarse la cámara',
        status: 'queued',
        terminalId: session.terminalId,
        channelId,
        saveFlag,
        strategy,
        platformSerial: null,
      };
    }
  }

  async queryStoredMedia(): Promise<{
    terminalId: string;
    totalItems: number;
    items: Array<StoredMediaItem & { multimediaIdHex: string }>;
  }> {
    const session = this.selectTargetSession();
    if (!session.authenticated || !session.socket || session.socket.destroyed) {
      throw new ConflictException(
        `Terminal ${session.terminalId} no está autenticado`,
      );
    }
    if (session.pendingMediaQuery) {
      throw new ConflictException(
        `Ya existe una consulta multimedia pendiente para ${session.terminalId}`,
      );
    }

    const items = await new Promise<StoredMediaItem[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pendingMediaQuery = null;
        reject(
          new GatewayTimeoutException(
            `Sin respuesta 0x0802 tras ${this.mediaQueryTimeoutMs}ms`,
          ),
        );
      }, this.mediaQueryTimeoutMs);

      session.pendingMediaQuery = {
        serialNumber: 0,
        timeout,
        resolve,
        reject,
      };

      try {
        this.sendStoredMediaQuery(session);
      } catch (error) {
        clearTimeout(timeout);
        session.pendingMediaQuery = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return {
      terminalId: session.terminalId,
      totalItems: items.length,
      items: items.map((item) => ({
        ...item,
        multimediaIdHex: `0x${item.multimediaId.toString(16).padStart(8, '0')}`,
      })),
    };
  }

  requestMediaFetch(multimediaId: number): {
    message: string;
    status: 'sent' | 'queued';
    terminalId: string;
    multimediaId: number;
    multimediaIdHex: string;
  } {
    const session = this.selectTargetSession();
    const connected =
      session.authenticated &&
      session.socket !== null &&
      !session.socket.destroyed;

    let sent = connected;
    try {
      this.sendStoredUploadRequest(session, multimediaId);
    } catch (error) {
      sent = false;
      session.authenticated = false;
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `No se pudo enviar 0x8805; quedó pendiente: ` +
          `terminal=${session.terminalId}, multimediaId=${multimediaId}, ` +
          `error=${detail}`,
      );
    }

    return {
      message: sent
        ? 'solicitud de subida enviada'
        : 'solicitud encolada; se enviará al autenticarse la cámara',
      status: sent ? 'sent' : 'queued',
      terminalId: session.terminalId,
      multimediaId,
      multimediaIdHex: `0x${multimediaId.toString(16).padStart(8, '0')}`,
    };
  }

  /**
   * Solicita video en tiempo real (0x9101) y arma espera de conexión al puerto media.
   */
  async requestVideoStart(options?: {
    channelId?: number;
    streamType?: 0 | 1;
    dataType?: 0 | 1;
    durationSeconds?: number;
  }): Promise<{
    message: string;
    status: 'sent';
    terminalId: string;
    channelId: number;
    dataType: number;
    streamType: number;
    serverIp: string;
    tcpPort: number;
    udpPort: number;
    platformSerial: number;
    durationSeconds: number;
  }> {
    const currentMedia = this.mediaServer.getStatus();
    if (
      (this.lastVideoRequest && !this.lastVideoRequest.stoppedAt) ||
      currentMedia.activeConnection ||
      currentMedia.waitingForConnection
    ) {
      await this.stopVideoSession(
        'reemplazada por nueva solicitud',
        true,
        this.lastVideoRequest?.channelId ?? 1,
      );
    }

    const session = this.selectTargetSession();
    if (!session.authenticated || !session.socket || session.socket.destroyed) {
      throw new ConflictException(
        `Terminal ${session.terminalId} no está autenticado; no se puede iniciar video`,
      );
    }

    const channelId = options?.channelId ?? 1;
    const streamType = options?.streamType ?? 0;
    const dataType = options?.dataType ?? 1;
    const durationSeconds = options?.durationSeconds ?? 30;
    const body = buildRealtimeVideoRequestBody({
      serverIp: this.mediaServerIp,
      tcpPort: this.mediaServerPort,
      udpPort: 0,
      channelId,
      dataType,
      streamType,
    });

    const platformSerial = this.send(
      session.socket,
      0x9101,
      session.terminalId,
      body,
      `iniciar video CH${channelId} dataType=${dataType} streamType=${streamType} → ${this.mediaServerIp}:${this.mediaServerPort}`,
    );

    this.lastVideoRequest = {
      terminalId: session.terminalId,
      channelId,
      dataType,
      streamType,
      platformSerial,
      requestedAt: new Date(),
      durationSeconds,
    };
    this.mediaServer.expectConnection(
      session.terminalId,
      () => this.handleVideoMediaConnected(platformSerial),
      () => {
        void this.stopVideoSession('sin conexión media', true, channelId);
      },
    );

    this.logger.log(
      `0x9101 enviado: terminal=${session.terminalId}, serial=${platformSerial}, ` +
        `media=${this.mediaServerIp}:${this.mediaServerPort}, canal=${channelId}`,
    );

    return {
      message: 'solicitud de video enviada; esperando conexión al puerto media',
      status: 'sent',
      terminalId: session.terminalId,
      channelId,
      dataType,
      streamType,
      serverIp: this.mediaServerIp,
      tcpPort: this.mediaServerPort,
      udpPort: 0,
      platformSerial,
      durationSeconds,
    };
  }

  /** Detiene el stream: 0x9102 cierre + cierra captura media local. */
  async requestVideoStop(channelId = 1): Promise<{
    message: string;
    terminalId: string;
    channelId: number;
    platformSerial: number | null;
    media: ReturnType<MediaServerService['getStatus']>;
  }> {
    const result = await this.stopVideoSession(
      'detención manual',
      true,
      channelId,
    );
    return {
      message: 'stop de video solicitado',
      terminalId: result.terminalId,
      channelId,
      platformSerial: result.platformSerial,
      media: result.media,
    };
  }

  getVideoStatus() {
    const media = this.mediaServer.getStatus();
    const now = Date.now();
    const remainingSeconds =
      this.lastVideoRequest?.endsAt && !this.lastVideoRequest.stoppedAt
        ? Math.max(
            0,
            Math.ceil((this.lastVideoRequest.endsAt.getTime() - now) / 1000),
          )
        : null;

    return {
      active:
        !!this.lastVideoRequest &&
        !this.lastVideoRequest.stoppedAt &&
        (media.activeConnection || media.waitingForConnection),
      remainingSeconds,
      lastRequest: this.lastVideoRequest
        ? {
            ...this.lastVideoRequest,
            requestedAt: this.lastVideoRequest.requestedAt.toISOString(),
            startedAt: this.lastVideoRequest.startedAt?.toISOString() ?? null,
            endsAt: this.lastVideoRequest.endsAt?.toISOString() ?? null,
            stoppedAt: this.lastVideoRequest.stoppedAt?.toISOString() ?? null,
            respondedAt:
              this.lastVideoRequest.respondedAt?.toISOString() ?? null,
          }
        : null,
      mediaServerIp: this.mediaServerIp,
      media,
    };
  }

  private handleVideoMediaConnected(platformSerial: number): void {
    const request = this.lastVideoRequest;
    if (
      !request ||
      request.platformSerial !== platformSerial ||
      request.stoppedAt
    ) {
      return;
    }

    const startedAt = new Date();
    request.startedAt = startedAt;
    request.endsAt = new Date(
      startedAt.getTime() + request.durationSeconds * 1000,
    );
    this.clearVideoStopTimer();
    this.videoStopTimer = setTimeout(() => {
      void this.stopVideoSession(
        'auto-corte por duración',
        true,
        request.channelId,
      );
    }, request.durationSeconds * 1000);

    this.logger.log(
      `Video JT1078 conectado; auto-corte en ${request.durationSeconds}s: ` +
        `terminal=${request.terminalId}, canal=${request.channelId}`,
    );
  }

  private async stopVideoSession(
    reason: string,
    sendControl: boolean,
    fallbackChannel: number,
  ): Promise<{
    terminalId: string;
    platformSerial: number | null;
    media: ReturnType<MediaServerService['getStatus']>;
  }> {
    this.clearVideoStopTimer();
    const request = this.lastVideoRequest;
    const session = this.selectTargetSession();
    const channelId = request?.channelId ?? fallbackChannel;
    let platformSerial: number | null = null;

    if (
      sendControl &&
      session.authenticated &&
      session.socket &&
      !session.socket.destroyed
    ) {
      const body = buildRealtimeVideoControlBody({
        channelId,
        controlCmd: 0,
        closeType: 0,
      });
      platformSerial = this.send(
        session.socket,
        0x9102,
        session.terminalId,
        body,
        `cerrar transmisión video CH${channelId}`,
      );
      this.logger.log(
        `0x9102 enviado: terminal=${session.terminalId}, canal=${channelId}, serial=${platformSerial}`,
      );
    } else if (sendControl) {
      this.logger.warn(
        `Stop video sin sesión autenticada: terminal=${session.terminalId}; ` +
          'solo se cierra el lado media local',
      );
    }

    const mediaBeforeStop = this.mediaServer.getStatus();
    await this.mediaServer.stopCapture(reason);
    const stoppedAt = new Date();
    if (request) {
      request.stoppedAt = stoppedAt;
      request.stopReason = reason;
    }
    const durationRealSeconds = request?.startedAt
      ? (stoppedAt.getTime() - request.startedAt.getTime()) / 1000
      : 0;

    this.logger.log(
      `VIDEO resumen final: motivo=${reason}, duración=${durationRealSeconds.toFixed(1)}s, ` +
        `packets=${mediaBeforeStop.packets}, bytes=${mediaBeforeStop.bytes}, ` +
        `jt1078=${mediaBeforeStop.jt1078MarkerSeen}, file=${mediaBeforeStop.rawFilePath}`,
    );

    return {
      terminalId: request?.terminalId ?? session.terminalId,
      platformSerial,
      media: this.mediaServer.getStatus(),
    };
  }

  private clearVideoStopTimer(): void {
    if (this.videoStopTimer) {
      clearTimeout(this.videoStopTimer);
      this.videoStopTimer = null;
    }
  }

  getStatus(): Array<{
    terminalId: string;
    authenticated: boolean;
    remoteAddress: string | null;
    lastSeen: string;
    queuedCommands: number;
    storedMediaItems: number;
    mediaQueryPending: boolean;
    pendingMultimedia: Array<{
      multimediaId: number;
      status: 'awaiting' | 'receiving';
      strategy: 'stored-0x8805' | 'immediate';
      requestedAt: string;
    }>;
  }> {
    return [...this.terminalSessions.values()].map((session) => ({
      terminalId: session.terminalId,
      authenticated:
        session.authenticated &&
        session.socket !== null &&
        !session.socket.destroyed,
      remoteAddress: session.remoteAddress,
      lastSeen: session.lastSeen.toISOString(),
      queuedCommands: session.commandQueue.length,
      storedMediaItems: session.storedMedia.length,
      mediaQueryPending: session.pendingMediaQuery !== null,
      pendingMultimedia: [...session.pendingMultimedia.values()].map(
        (pending) => ({
          multimediaId: pending.multimediaId,
          status: pending.status,
          strategy: pending.strategy,
          requestedAt: pending.requestedAt.toISOString(),
        }),
      ),
    }));
  }

  private handleConnection(socket: net.Socket): void {
    const remote = this.remoteAddress(socket);
    this.connections.set(socket, {
      decoder: new Jt808FrameDecoder(),
    });

    socket.setKeepAlive(true);
    this.logger.log(`Conexión TCP abierta desde ${remote}`);

    socket.on('data', (chunk: Buffer) => {
      const state = this.connections.get(socket);
      if (!state) {
        return;
      }

      for (const escapedFrame of state.decoder.push(chunk)) {
        this.handleFrame(socket, state, escapedFrame);
      }
    });

    socket.on('close', () => {
      const state = this.connections.get(socket);
      const terminal = state?.terminalId ?? 'desconocido';
      state?.decoder.reset();
      this.connections.delete(socket);
      if (terminal !== 'desconocido') {
        this.handleSocketClosed(terminal, socket);
      }
      this.logger.log(
        `Conexión TCP cerrada: terminal=${terminal}, remoto=${remote}`,
      );
    });

    socket.on('error', (error: Error) => {
      const terminal =
        this.connections.get(socket)?.terminalId ?? 'desconocido';
      this.logger.error(
        `Error de socket: terminal=${terminal}, remoto=${remote}, error=${error.message}`,
      );
    });
  }

  private handleFrame(
    socket: net.Socket,
    state: ConnectionState,
    escapedFrame: Buffer,
  ): void {
    const fullFrame = Buffer.concat([
      Buffer.from([0x7e]),
      escapedFrame,
      Buffer.from([0x7e]),
    ]);

    if (this.debugHex) {
      this.logger.debug(`RX ${fullFrame.toString('hex')}`);
    }

    try {
      const decoded = unescapeJt808(escapedFrame);
      if (decoded.length < 13) {
        throw new Error('Trama demasiado corta para header y checksum');
      }

      const receivedChecksum = decoded[decoded.length - 1];
      const payload = decoded.subarray(0, decoded.length - 1);
      const expectedChecksum = calcChecksum(payload);
      if (receivedChecksum !== expectedChecksum) {
        throw new Error(
          `Checksum inválido: recibido=0x${receivedChecksum.toString(16).padStart(2, '0')}, ` +
            `esperado=0x${expectedChecksum.toString(16).padStart(2, '0')}`,
        );
      }

      const message = parseHeader(payload);
      state.terminalId = message.terminalId;
      const session = this.getOrCreateSession(message.terminalId);
      session.lastSeen = new Date();
      if (session.socket === socket) {
        session.remoteAddress = this.remoteAddress(socket);
      }
      if (payload.length !== message.headerLength + message.bodyLength) {
        throw new Error(
          `Longitud de trama inconsistente: payload=${payload.length}, ` +
            `esperado=${message.headerLength + message.bodyLength}`,
        );
      }

      this.logReceived(message);
      this.captureLogger.logFrame({
        direction: 'RX',
        remote: this.remoteAddress(socket),
        terminalId: message.terminalId,
        messageId: message.messageId,
        messageLabel: MESSAGE_NAMES[message.messageId] ?? 'Desconocido',
        frame: fullFrame,
        includeHexDump: message.messageId !== 0x0801,
      });

      if (
        message.messageId === 0x0801 &&
        (!message.hasSubpackages || message.packageNo === 1) &&
        message.body.length >= 4
      ) {
        const multimediaId = message.body.readUInt32BE(0);
        this.markMultimediaUploadStarted(message.terminalId, multimediaId);
      }

      if (message.hasSubpackages) {
        this.handleSubpackageFrame(socket, message);
        return;
      }

      this.dispatchCompleteMessage(socket, state, message, message.body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Trama JT808 descartada: ${detail}`);
      if (!this.debugHex) {
        this.logger.warn(`RX inválido ${escapedFrame.toString('hex')}`);
      }
      this.captureLogger.logFrame({
        direction: 'RX',
        remote: this.remoteAddress(socket),
        terminalId: state.terminalId,
        messageId: 0xffff,
        messageLabel: `Descartada: ${detail}`,
        frame: fullFrame,
      });
    }
  }

  private handleSubpackageFrame(
    socket: net.Socket,
    message: Jt808Header,
  ): void {
    const total = message.packageTotal ?? 0;
    const packageNo = message.packageNo ?? 0;
    const key = `${message.terminalId}:${message.messageId}:${message.serialNumber}`;

    let pending = this.bodyAssemblies.get(key);
    if (!pending) {
      pending = {
        terminalId: message.terminalId,
        messageId: message.messageId,
        serialNumber: message.serialNumber,
        assembler: new SubpackageAssembler(total),
        socket,
      };
      this.bodyAssemblies.set(key, pending);
      this.logger.log(
        `Subpaquetes iniciados: terminal=${message.terminalId}, ` +
          `messageId=${this.formatMessage(message.messageId)}, ` +
          `serial=${message.serialNumber}, total=${total}`,
      );
    }

    const complete = pending.assembler.add(packageNo, message.body);
    this.logger.log(
      `Subpaquete ${packageNo}/${total} recibido ` +
        `(${pending.assembler.receivedCount()}/${total}) ` +
        `terminal=${message.terminalId}`,
    );

    if (!complete) {
      return;
    }

    this.bodyAssemblies.delete(key);
    const assembledBody = pending.assembler.assemble();
    const state = this.connections.get(socket) ?? {
      decoder: new Jt808FrameDecoder(),
      terminalId: message.terminalId,
    };

    this.dispatchCompleteMessage(
      socket,
      state,
      { ...message, body: assembledBody, bodyLength: assembledBody.length },
      assembledBody,
    );
  }

  private dispatchCompleteMessage(
    socket: net.Socket,
    state: ConnectionState,
    message: Jt808Header,
    body: Buffer,
  ): void {
    const completeMessage: Jt808Header = { ...message, body };

    switch (completeMessage.messageId) {
      case 0x0001:
        this.handleTerminalGeneralResponse(completeMessage);
        break;
      case 0x8001:
        // Algunos firmwares etiquetan su ACK genérico como 0x8001.
        this.handleTerminalGeneralResponse(completeMessage);
        break;
      case 0x0100:
        this.handleRegistration(socket, state, completeMessage);
        break;
      case 0x0102:
        this.handleAuthentication(socket, state, completeMessage);
        break;
      case 0x0002:
        this.sendGeneralResponse(socket, completeMessage, 0x00, 'heartbeat');
        break;
      case 0x0200:
        this.handleLocation(socket, completeMessage);
        break;
      case 0x0805:
        this.handleCameraControlResponse(socket, completeMessage);
        break;
      case 0x0801:
        void this.handleMultimediaUpload(socket, completeMessage);
        break;
      case 0x0802:
        this.handleStoredMediaQueryResponse(completeMessage);
        break;
      default:
        this.logger.warn(
          `Mensaje no manejado aún: terminal=${completeMessage.terminalId}, ` +
            `messageId=${this.formatMessage(completeMessage.messageId)}`,
        );
        this.sendGeneralResponse(
          socket,
          completeMessage,
          0x00,
          'no manejado aún',
        );
    }
  }

  private handleTerminalGeneralResponse(message: Jt808Header): void {
    try {
      const response = parseTerminalGeneralResponse(message.body);
      const log =
        `${this.formatMessage(message.messageId)} terminal=${message.terminalId}, ` +
        `serialRespondido=${response.responseSerial}, ` +
        `mensajeRespondido=${this.formatMessage(response.responseMessageId)}, ` +
        `resultado=${response.result} (${response.resultLabel})`;

      if (response.result === 0) {
        this.logger.log(log);
      } else {
        this.logger.warn(log);
      }

      if (
        response.responseMessageId === 0x9101 &&
        this.lastVideoRequest?.terminalId === message.terminalId &&
        this.lastVideoRequest.platformSerial === response.responseSerial
      ) {
        this.lastVideoRequest.responseResult = response.result;
        this.lastVideoRequest.responseLabel = response.resultLabel;
        this.lastVideoRequest.respondedAt = new Date();
        if (response.result !== 0) {
          this.logger.warn(
            `La cámara rechazó 0x9101: result=${response.result} ` +
              `(${response.resultLabel})`,
          );
          void this.stopVideoSession(
            `0x9101 rechazado: ${response.resultLabel}`,
            false,
            this.lastVideoRequest.channelId,
          );
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error al parsear 0x0001: ${detail}`);
    }
  }

  private handleStoredMediaQueryResponse(message: Jt808Header): void {
    try {
      const response = parseStoredMediaQueryResponse(message.body);
      const session = this.getOrCreateSession(message.terminalId);
      session.storedMedia = response.items;

      const ids = response.items
        .map((item) => `0x${item.multimediaId.toString(16).padStart(8, '0')}`)
        .join(', ');
      this.logger.log(
        `0x0802 terminal=${message.terminalId}, total=${response.totalItems}, ` +
          `multimediaIds=[${ids}]`,
      );

      const pending = session.pendingMediaQuery;
      if (!pending) {
        this.logger.warn(
          `0x0802 sin consulta HTTP pendiente: terminal=${message.terminalId}`,
        );
        return;
      }
      if (pending.serialNumber !== response.responseSerial) {
        this.logger.warn(
          `0x0802 serial distinto tras reconexión: esperado=${pending.serialNumber}, ` +
            `recibido=${response.responseSerial}; se acepta por terminalId`,
        );
      }

      clearTimeout(pending.timeout);
      session.pendingMediaQuery = null;
      pending.resolve(response.items);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error al parsear 0x0802: ${detail}`);
    }
  }

  private handleRegistration(
    socket: net.Socket,
    state: ConnectionState,
    message: Jt808Header,
  ): void {
    const token = this.createToken(message.terminalId);
    this.tokens.set(message.terminalId, token);
    state.terminalId = message.terminalId;
    const session = this.getOrCreateSession(message.terminalId);
    this.bindSessionSocket(session, socket, false);

    const body = Buffer.alloc(3 + Buffer.byteLength(token, 'ascii'));
    body.writeUInt16BE(message.serialNumber, 0);
    body[2] = 0x00;
    body.write(token, 3, 'ascii');

    this.send(socket, 0x8100, message.terminalId, body, 'registro aceptado');
  }

  private handleAuthentication(
    socket: net.Socket,
    state: ConnectionState,
    message: Jt808Header,
  ): void {
    const session = this.getOrCreateSession(message.terminalId);
    const expectedToken =
      this.tokens.get(message.terminalId) ??
      this.createToken(message.terminalId);
    const receivedToken = message.body.toString('ascii');
    const accepted = receivedToken === expectedToken;

    if (accepted) {
      this.tokens.set(message.terminalId, expectedToken);
      state.terminalId = message.terminalId;
      this.bindSessionSocket(session, socket, true);
    }

    this.sendGeneralResponse(
      socket,
      message,
      accepted ? 0x00 : 0x01,
      accepted ? 'autenticación aceptada' : 'token de autenticación inválido',
    );

    if (accepted) {
      this.drainSessionWork(session);
    }
  }

  private handleLocation(socket: net.Socket, message: Jt808Header): void {
    try {
      const location = parseLocation(message.body);

      this.logger.log(
        `POS terminal=${message.terminalId} ` +
          `lat=${location.latitude.toFixed(6)} lng=${location.longitude.toFixed(6)} ` +
          `speed=${location.speedKmh.toFixed(1)}km/h dir=${location.direction}° ` +
          `timeMX=${location.timeLocalMx} validPos=${location.positionValid}`,
      );

      this.historicoLogger.logLocation({
        remote: this.remoteAddress(socket),
        terminalId: message.terminalId,
        location,
      });

      this.sendGeneralResponse(socket, message, 0x00, 'posición aceptada');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `No se pudo parsear 0x0200 de terminal=${message.terminalId}: ${detail}`,
      );
      this.sendGeneralResponse(
        socket,
        message,
        0x00,
        'posición ACK (parse falló)',
      );
    }
  }

  private handleCameraControlResponse(
    socket: net.Socket,
    message: Jt808Header,
  ): void {
    try {
      const response = parseCameraControlResponse(message.body);
      const command = this.consumeCaptureCommand(response.responseSerial);

      if (response.result === 0) {
        const strategy =
          command?.saveFlag === 0 ? 'immediate' : 'stored-0x8805';
        this.logger.log(
          `0x0805 éxito: terminal=${message.terminalId}, ` +
            `serialRespondido=${response.responseSerial}, ` +
            `multimediaIds=[${response.multimediaIds.join(', ')}], ` +
            `estrategia=${strategy}`,
        );

        if (response.multimediaIds.length === 0) {
          this.logger.warn(
            `0x0805 exitoso sin multimediaId: terminal=${message.terminalId}`,
          );
        }

        const session = this.getOrCreateSession(message.terminalId);
        for (const multimediaId of response.multimediaIds) {
          if (strategy === 'stored-0x8805') {
            this.sendStoredUploadRequest(session, multimediaId);
            this.logger.log(
              `0x8805 enviado: terminal=${message.terminalId}, ` +
                `multimediaId=${multimediaId}, deleteFlag=0`,
            );
          } else {
            this.armUploadTimeout(message.terminalId, multimediaId, strategy);
            this.logger.log(
              `Esperando subida inmediata 0x0801: terminal=${message.terminalId}, ` +
                `multimediaId=${multimediaId}`,
            );
          }
        }
      } else {
        this.logger.warn(
          `Cámara RECHAZÓ la captura: terminal=${message.terminalId}, ` +
            `result=${response.result} (${response.resultLabel}), ` +
            `serialRespondido=${response.responseSerial}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error al parsear 0x0805: ${detail}`);
    }
  }

  private async handleMultimediaUpload(
    socket: net.Socket,
    message: Jt808Header,
  ): Promise<void> {
    try {
      const upload = parseMultimediaUpload(message.body);
      this.markMultimediaUploadStarted(message.terminalId, upload.multimediaId);

      const looksJpeg =
        upload.mediaData.length >= 2 &&
        upload.mediaData[0] === 0xff &&
        upload.mediaData[1] === 0xd8;
      if (!looksJpeg) {
        this.logger.warn(
          `Multimedia no inicia con FF D8: terminal=${message.terminalId}, ` +
            `multimediaId=${upload.multimediaId}, ` +
            `primerosBytes=${upload.mediaData.subarray(0, 8).toString('hex')}`,
        );
      }

      const filePath = await this.savePhotoFile(
        message.terminalId,
        upload.multimediaId,
        upload.mediaData,
      );

      this.logger.log(
        `Foto guardada: terminal=${message.terminalId}, ` +
          `multimediaId=${upload.multimediaId}, ` +
          `tipo=${upload.multimediaType}, formato=${upload.multimediaFormat}, ` +
          `canal=${upload.channelId}, dataOffset=${upload.mediaDataOffset}, ` +
          `bytes=${upload.mediaData.length}, ` +
          `jpegMagic=${looksJpeg}, path=${filePath}`,
      );

      const ackBody = buildMultimediaUploadAck(upload.multimediaId);
      this.send(
        socket,
        0x8800,
        message.terminalId,
        ackBody,
        `ACK multimedia ${upload.multimediaId}`,
      );
      this.completeMultimediaUpload(message.terminalId, upload.multimediaId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Error al procesar 0x0801 de terminal=${message.terminalId}: ${detail}`,
      );
      this.sendGeneralResponse(socket, message, 0x01, '0x0801 falló');
    }
  }

  private async savePhotoFile(
    terminalId: string,
    multimediaId: number,
    mediaData: Buffer,
  ): Promise<string> {
    fs.mkdirSync(this.fotosDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `foto-${terminalId}-${multimediaId}-${stamp}.jpg`;
    const filePath = path.join(this.fotosDir, fileName);
    await fs.promises.writeFile(filePath, mediaData);
    return filePath;
  }

  private armCaptureTimeout(
    platformSerial: number,
    terminalId: string,
    channelId: number,
    saveFlag: 0 | 1,
  ): void {
    this.clearCaptureTimeout(platformSerial);

    const timeout = setTimeout(() => {
      this.pendingCameraCommands.delete(platformSerial);
      const session = this.terminalSessions.get(terminalId);
      if (!session?.authenticated || !session.socket) {
        session?.commandQueue.push({
          channelId,
          saveFlag,
          queuedAt: new Date(),
        });
      }
      this.logger.warn(
        `Sin respuesta de captura (0x0805) tras ${this.captureTimeoutMs}ms: ` +
          `terminal=${terminalId}, canal=${channelId}, saveFlag=${saveFlag}, ` +
          `serialPlataforma=${platformSerial}. ` +
          'Posible no soporte del comando 0x8801.',
      );
    }, this.captureTimeoutMs);

    this.pendingCameraCommands.set(platformSerial, {
      terminalId,
      channelId,
      saveFlag,
      timeout,
    });
  }

  private consumeCaptureCommand(
    platformSerial: number,
  ): PendingCameraCommand | undefined {
    const pending = this.pendingCameraCommands.get(platformSerial);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timeout);
    this.pendingCameraCommands.delete(platformSerial);
    return pending;
  }

  private clearCaptureTimeout(platformSerial: number): void {
    this.consumeCaptureCommand(platformSerial);
  }

  private armUploadTimeout(
    terminalId: string,
    multimediaId: number,
    strategy: 'stored-0x8805' | 'immediate',
  ): void {
    const session = this.getOrCreateSession(terminalId);
    const existing = session.pendingMultimedia.get(multimediaId);
    if (existing?.timeout) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      session.pendingMultimedia.delete(multimediaId);
      this.logger.warn(
        `Sin subida de multimedia tras ${this.uploadTimeoutMs}ms: ` +
          `terminal=${terminalId}, multimediaId=${multimediaId}, ` +
          `estrategia=${strategy}`,
      );
    }, this.uploadTimeoutMs);

    session.pendingMultimedia.set(multimediaId, {
      terminalId,
      multimediaId,
      strategy,
      status: 'awaiting',
      timeout,
      requestedAt: existing?.requestedAt ?? new Date(),
    });
  }

  private markMultimediaUploadStarted(
    terminalId: string,
    multimediaId: number,
  ): void {
    const session = this.terminalSessions.get(terminalId);
    const pending = session?.pendingMultimedia.get(multimediaId);
    if (pending) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
        pending.timeout = null;
      }
      pending.status = 'receiving';
      this.logger.log(
        `Subida 0x0801 iniciada: terminal=${terminalId}, ` +
          `multimediaId=${multimediaId}, estrategia=${pending.strategy}`,
      );
    }
  }

  private completeMultimediaUpload(
    terminalId: string,
    multimediaId: number,
  ): void {
    const session = this.terminalSessions.get(terminalId);
    const pending = session?.pendingMultimedia.get(multimediaId);
    if (pending?.timeout) {
      clearTimeout(pending.timeout);
    }
    session?.pendingMultimedia.delete(multimediaId);
  }

  private getOrCreateSession(terminalId: string): TerminalSession {
    let session = this.terminalSessions.get(terminalId);
    if (!session) {
      session = {
        terminalId,
        socket: null,
        authenticated: false,
        remoteAddress: null,
        lastSeen: new Date(),
        commandQueue: [],
        pendingMultimedia: new Map<number, PendingMultimediaUpload>(),
        storedMedia: [],
        pendingMediaQuery: null,
      };
      this.terminalSessions.set(terminalId, session);
    }
    return session;
  }

  private selectTargetSession(): TerminalSession {
    const authenticated = [...this.terminalSessions.values()]
      .filter(
        (session) =>
          session.authenticated &&
          session.socket !== null &&
          !session.socket.destroyed,
      )
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];

    if (authenticated) {
      return authenticated;
    }

    return (
      this.terminalSessions.get(this.defaultTerminalId) ??
      this.getOrCreateSession(this.defaultTerminalId)
    );
  }

  private bindSessionSocket(
    session: TerminalSession,
    socket: net.Socket,
    authenticated: boolean,
  ): void {
    const previousSocket = session.socket;
    if (
      previousSocket &&
      previousSocket !== socket &&
      !previousSocket.destroyed
    ) {
      this.logger.warn(
        `Cambio de conexión 4G: terminal=${session.terminalId}, ` +
          `anterior=${session.remoteAddress}, nueva=${this.remoteAddress(socket)}`,
      );
      this.requeueInflightCommands(session.terminalId);
      this.suspendPendingUploads(session);
      this.clearAssembliesForTerminal(session.terminalId);
      previousSocket.destroy();
    }

    session.socket = socket;
    session.authenticated = authenticated;
    session.remoteAddress = this.remoteAddress(socket);
    session.lastSeen = new Date();
  }

  private handleSocketClosed(terminalId: string, socket: net.Socket): void {
    const session = this.terminalSessions.get(terminalId);
    if (!session || session.socket !== socket) {
      return;
    }

    session.socket = null;
    session.authenticated = false;
    session.lastSeen = new Date();
    this.requeueInflightCommands(terminalId);
    this.suspendPendingUploads(session);
    this.clearAssembliesForTerminal(terminalId);
  }

  private sendCaptureCommand(
    session: TerminalSession,
    channelId: number,
    saveFlag: 0 | 1,
  ): number {
    if (!session.socket || session.socket.destroyed) {
      throw new Error(`Terminal ${session.terminalId} sin socket activo`);
    }

    const strategy = saveFlag === 1 ? 'stored-0x8805' : 'immediate';
    const body = buildCameraShootBody({ channelId, saveFlag });
    const platformSerial = this.send(
      session.socket,
      0x8801,
      session.terminalId,
      body,
      `captura solicitada canal=${channelId}, estrategia=${strategy}`,
    );

    this.armCaptureTimeout(
      platformSerial,
      session.terminalId,
      channelId,
      saveFlag,
    );
    this.logger.log(
      `Captura enviada: terminal=${session.terminalId}, canal=${channelId}, ` +
        `saveFlag=${saveFlag}, estrategia=${strategy}, ` +
        `serialPlataforma=${platformSerial}`,
    );
    return platformSerial;
  }

  private drainSessionWork(session: TerminalSession): void {
    if (!session.authenticated || !session.socket || session.socket.destroyed) {
      return;
    }

    while (session.commandQueue.length > 0) {
      const command = session.commandQueue.shift()!;
      try {
        this.sendCaptureCommand(session, command.channelId, command.saveFlag);
      } catch (error) {
        session.commandQueue.unshift(command);
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `No se pudo drenar cola de terminal=${session.terminalId}: ${detail}`,
        );
        break;
      }
    }

    if (session.pendingMediaQuery) {
      try {
        this.sendStoredMediaQuery(session);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `No se pudo reintentar consulta multimedia de ` +
            `terminal=${session.terminalId}: ${detail}`,
        );
      }
    }

    for (const pending of session.pendingMultimedia.values()) {
      try {
        this.sendStoredUploadRequest(session, pending.multimediaId, true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `No se pudo reintentar multimedia=${pending.multimediaId} ` +
            `terminal=${session.terminalId}: ${detail}`,
        );
      }
    }
  }

  private sendStoredMediaQuery(session: TerminalSession): void {
    if (!session.authenticated || !session.socket || session.socket.destroyed) {
      throw new Error(`Terminal ${session.terminalId} sin sesión autenticada`);
    }
    if (!session.pendingMediaQuery) {
      throw new Error('No existe consulta multimedia pendiente');
    }

    const serialNumber = this.send(
      session.socket,
      0x8802,
      session.terminalId,
      buildStoredMediaQueryBody(),
      'consultar todas las imágenes almacenadas',
    );
    session.pendingMediaQuery.serialNumber = serialNumber;
    this.logger.log(
      `0x8802 enviado: terminal=${session.terminalId}, serial=${serialNumber}`,
    );
  }

  private sendStoredUploadRequest(
    session: TerminalSession,
    multimediaId: number,
    reconnectRetry = false,
  ): void {
    const existing = session.pendingMultimedia.get(multimediaId);
    if (!existing) {
      session.pendingMultimedia.set(multimediaId, {
        terminalId: session.terminalId,
        multimediaId,
        strategy: 'stored-0x8805',
        status: 'awaiting',
        timeout: null,
        requestedAt: new Date(),
      });
    }

    if (!session.authenticated || !session.socket || session.socket.destroyed) {
      return;
    }

    const strategy =
      session.pendingMultimedia.get(multimediaId)?.strategy ?? 'stored-0x8805';
    this.armUploadTimeout(session.terminalId, multimediaId, strategy);
    this.send(
      session.socket,
      0x8805,
      session.terminalId,
      buildStoredMultimediaUploadCommand(multimediaId, 0),
      `${reconnectRetry ? 'reintento' : 'solicitud'} multimedia id=${multimediaId}, deleteFlag=0`,
    );
  }

  private requeueInflightCommands(terminalId: string): void {
    const session = this.terminalSessions.get(terminalId);
    if (!session) {
      return;
    }

    for (const [serial, pending] of this.pendingCameraCommands) {
      if (pending.terminalId === terminalId) {
        clearTimeout(pending.timeout);
        this.pendingCameraCommands.delete(serial);
        session.commandQueue.push({
          channelId: pending.channelId,
          saveFlag: pending.saveFlag,
          queuedAt: new Date(),
        });
      }
    }
  }

  private suspendPendingUploads(session: TerminalSession): void {
    for (const pending of session.pendingMultimedia.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
        pending.timeout = null;
      }
      pending.status = 'awaiting';
    }
  }

  private clearAssembliesForTerminal(terminalId: string): void {
    for (const [key, assembly] of this.bodyAssemblies) {
      if (assembly.terminalId === terminalId) {
        this.bodyAssemblies.delete(key);
      }
    }
  }

  private sendGeneralResponse(
    socket: net.Socket,
    request: Jt808Header,
    result: number,
    detail: string,
  ): void {
    const body = Buffer.alloc(5);
    body.writeUInt16BE(request.serialNumber, 0);
    body.writeUInt16BE(request.messageId, 2);
    body[4] = result;

    this.send(socket, 0x8001, request.terminalId, body, detail);
  }

  private send(
    socket: net.Socket,
    messageId: number,
    terminalId: string,
    body: Buffer,
    detail: string,
  ): number {
    const serialNumber = this.nextPlatformSerial();
    const frame = buildMessage(messageId, terminalId, serialNumber, body);

    socket.write(frame, (error?: Error | null) => {
      if (error) {
        this.logger.error(
          `No se pudo enviar ${this.formatMessage(messageId)} a ` +
            `terminal=${terminalId}: ${error.message}`,
        );
        return;
      }

      this.logger.log(
        `TX terminal=${terminalId}, messageId=${this.formatMessage(messageId)}, ` +
          `serial=${serialNumber}, resultado=${detail}`,
      );
    });

    this.captureLogger.logFrame({
      direction: 'TX',
      remote: this.remoteAddress(socket),
      terminalId,
      messageId,
      messageLabel: MESSAGE_NAMES[messageId] ?? 'Desconocido',
      frame,
    });

    if (this.debugHex) {
      this.logger.debug(`TX ${frame.toString('hex')}`);
    }

    return serialNumber;
  }

  private logReceived(message: Jt808Header): void {
    const sub = message.hasSubpackages
      ? `, pkg=${message.packageNo}/${message.packageTotal}`
      : '';
    this.logger.log(
      `RX terminal=${message.terminalId}, ` +
        `messageId=${this.formatMessage(message.messageId)}, ` +
        `serial=${message.serialNumber}, body=${message.bodyLength} bytes${sub}`,
    );
  }

  private nextPlatformSerial(): number {
    this.platformSerial = (this.platformSerial + 1) & 0xffff;
    return this.platformSerial;
  }

  private createToken(terminalId: string): string {
    return `JT808-${terminalId}`;
  }

  private formatMessage(messageId: number): string {
    const hex = `0x${messageId.toString(16).padStart(4, '0')}`;
    return `${hex} (${MESSAGE_NAMES[messageId] ?? 'Desconocido'})`;
  }

  private remoteAddress(socket: net.Socket): string {
    return `${socket.remoteAddress ?? 'desconocido'}:${socket.remotePort ?? 0}`;
  }
}
