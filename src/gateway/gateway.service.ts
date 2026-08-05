import {
  ConflictException,
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
  buildCameraShootBody,
  buildMultimediaUploadAck,
  buildStoredMultimediaUploadCommand,
  parseCameraControlResponse,
  parseMultimediaUpload,
  SubpackageAssembler,
} from './jt808.multimedia';
import {
  buildMessage,
  calcChecksum,
  Jt808FrameDecoder,
  Jt808Header,
  parseHeader,
  unescape as unescapeJt808,
} from './jt808.codec';

const MESSAGE_NAMES: Record<number, string> = {
  0x0002: 'Heartbeat',
  0x0100: 'Registro',
  0x0102: 'Autenticación',
  0x0200: 'Posición GPS',
  0x0704: 'Posiciones en lote',
  0x0801: 'Subida multimedia',
  0x0805: 'Respuesta control cámara',
  0x8001: 'Respuesta genérica de plataforma',
  0x8100: 'Respuesta de registro',
  0x8800: 'ACK subida multimedia',
  0x8801: 'Control inmediato de cámara',
  0x8805: 'Solicitar multimedia almacenado',
};

interface ConnectionState {
  decoder: Jt808FrameDecoder;
  terminalId?: string;
  authenticated: boolean;
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
  timeout: NodeJS.Timeout;
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
  private readonly tokens = new Map<string, string>();
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private readonly pendingCameraCommands = new Map<
    number,
    PendingCameraCommand
  >();
  private readonly pendingMultimediaUploads = new Map<
    string,
    PendingMultimediaUpload
  >();
  private readonly bodyAssemblies = new Map<string, PendingBodyAssembly>();
  private server: net.Server | null = null;
  private platformSerial = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly captureLogger: CaptureLoggerService,
    private readonly historicoLogger: HistoricoLoggerService,
  ) {
    this.port = this.configService.get<number>('GATEWAY_PORT', 9001);
    this.debugHex =
      this.configService.get<boolean>('GATEWAY_DEBUG_HEX', false) ?? false;
    this.captureTimeoutMs =
      this.configService.get<number>('GATEWAY_CAPTURE_TIMEOUT_MS', 30000) ??
      30000;
    this.uploadTimeoutMs =
      this.configService.get<number>('GATEWAY_UPLOAD_TIMEOUT', 30000) ?? 30000;

    const configuredFotos =
      this.configService.get<string>('GATEWAY_FOTOS_DIR') ?? './fotos';
    this.fotosDir = path.isAbsolute(configuredFotos)
      ? configuredFotos
      : path.resolve(process.cwd(), configuredFotos);
  }

  onModuleInit(): void {
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
    for (const pending of this.pendingCameraCommands.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCameraCommands.clear();
    for (const pending of this.pendingMultimediaUploads.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingMultimediaUploads.clear();
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

  /**
   * Dispara 0x8801 a la primera cámara autenticada conectada.
   * Endpoint de prueba: sin JWT.
   */
  requestPhotoCapture(
    channelId = 2,
    saveFlag: 0 | 1 = 1,
  ): {
    message: string;
    terminalId: string;
    channelId: number;
    saveFlag: 0 | 1;
    strategy: 'stored-0x8805' | 'immediate';
    platformSerial: number;
  } {
    const connected = this.findAuthenticatedConnection();
    if (!connected) {
      throw new ConflictException(
        'No hay ninguna dashcam autenticada conectada al gateway TCP',
      );
    }

    const strategy = saveFlag === 1 ? 'stored-0x8805' : 'immediate';
    const body = buildCameraShootBody({ channelId, saveFlag });
    const platformSerial = this.send(
      connected.socket,
      0x8801,
      connected.terminalId,
      body,
      `captura solicitada canal=${channelId}, estrategia=${strategy}`,
    );

    this.armCaptureTimeout(
      platformSerial,
      connected.terminalId,
      channelId,
      saveFlag,
    );

    this.logger.log(
      `Captura solicitada: terminal=${connected.terminalId}, ` +
        `canal=${channelId}, saveFlag=${saveFlag}, estrategia=${strategy}, ` +
        `serialPlataforma=${platformSerial}`,
    );

    return {
      message: 'captura solicitada',
      terminalId: connected.terminalId,
      channelId,
      saveFlag,
      strategy,
      platformSerial,
    };
  }

  private handleConnection(socket: net.Socket): void {
    const remote = this.remoteAddress(socket);
    this.connections.set(socket, {
      decoder: new Jt808FrameDecoder(),
      authenticated: false,
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
      this.clearStateForTerminal(terminal);
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
      authenticated: false,
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

  private handleRegistration(
    socket: net.Socket,
    state: ConnectionState,
    message: Jt808Header,
  ): void {
    const token = this.createToken(message.terminalId);
    this.tokens.set(message.terminalId, token);
    state.terminalId = message.terminalId;
    state.authenticated = false;

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
    const expectedToken = this.tokens.get(message.terminalId);
    const receivedToken = message.body.toString('ascii');
    const accepted =
      expectedToken !== undefined && receivedToken === expectedToken;

    if (accepted) {
      state.terminalId = message.terminalId;
      state.authenticated = true;
    }

    this.sendGeneralResponse(
      socket,
      message,
      accepted ? 0x00 : 0x01,
      accepted ? 'autenticación aceptada' : 'token de autenticación inválido',
    );
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

        for (const multimediaId of response.multimediaIds) {
          this.armUploadTimeout(message.terminalId, multimediaId, strategy);

          if (strategy === 'stored-0x8805') {
            const uploadBody = buildStoredMultimediaUploadCommand(
              multimediaId,
              0,
            );
            this.send(
              socket,
              0x8805,
              message.terminalId,
              uploadBody,
              `solicitar multimedia almacenado id=${multimediaId}, deleteFlag=0`,
            );
            this.logger.log(
              `0x8805 enviado: terminal=${message.terminalId}, ` +
                `multimediaId=${multimediaId}, deleteFlag=0`,
            );
          } else {
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
    const key = this.multimediaKey(terminalId, multimediaId);
    this.clearUploadTimeout(terminalId, multimediaId);

    const timeout = setTimeout(() => {
      this.pendingMultimediaUploads.delete(key);
      this.logger.warn(
        `Sin subida de multimedia tras ${this.uploadTimeoutMs}ms: ` +
          `terminal=${terminalId}, multimediaId=${multimediaId}, ` +
          `estrategia=${strategy}`,
      );
    }, this.uploadTimeoutMs);

    this.pendingMultimediaUploads.set(key, {
      terminalId,
      multimediaId,
      strategy,
      timeout,
    });
  }

  private markMultimediaUploadStarted(
    terminalId: string,
    multimediaId: number,
  ): void {
    const pending = this.clearUploadTimeout(terminalId, multimediaId);
    if (pending) {
      this.logger.log(
        `Subida 0x0801 iniciada: terminal=${terminalId}, ` +
          `multimediaId=${multimediaId}, estrategia=${pending.strategy}`,
      );
    }
  }

  private clearUploadTimeout(
    terminalId: string,
    multimediaId: number,
  ): PendingMultimediaUpload | undefined {
    const key = this.multimediaKey(terminalId, multimediaId);
    const pending = this.pendingMultimediaUploads.get(key);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timeout);
    this.pendingMultimediaUploads.delete(key);
    return pending;
  }

  private multimediaKey(terminalId: string, multimediaId: number): string {
    return `${terminalId}:${multimediaId}`;
  }

  private clearStateForTerminal(terminalId: string): void {
    for (const [serial, pending] of this.pendingCameraCommands) {
      if (pending.terminalId === terminalId) {
        clearTimeout(pending.timeout);
        this.pendingCameraCommands.delete(serial);
      }
    }
    for (const [key, pending] of this.pendingMultimediaUploads) {
      if (pending.terminalId === terminalId) {
        clearTimeout(pending.timeout);
        this.pendingMultimediaUploads.delete(key);
      }
    }
    for (const [key, assembly] of this.bodyAssemblies) {
      if (assembly.terminalId === terminalId) {
        this.bodyAssemblies.delete(key);
      }
    }
  }

  private findAuthenticatedConnection(): {
    socket: net.Socket;
    terminalId: string;
  } | null {
    for (const [socket, state] of this.connections) {
      if (state.authenticated && state.terminalId && !socket.destroyed) {
        return { socket, terminalId: state.terminalId };
      }
    }
    return null;
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
