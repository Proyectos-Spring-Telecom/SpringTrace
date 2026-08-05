import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import { CaptureLoggerService } from './capture-logger.service';
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
  0x8001: 'Respuesta genérica de plataforma',
  0x8100: 'Respuesta de registro',
};

interface ConnectionState {
  decoder: Jt808FrameDecoder;
  terminalId?: string;
  authenticated: boolean;
}

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayService.name);
  private readonly port: number;
  private readonly debugHex: boolean;
  private readonly tokens = new Map<string, string>();
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private server: net.Server | null = null;
  private platformSerial = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly captureLogger: CaptureLoggerService,
  ) {
    this.port = this.configService.get<number>('GATEWAY_PORT', 9001);
    this.debugHex =
      this.configService.get<boolean>('GATEWAY_DEBUG_HEX', false) ?? false;
  }

  onModuleInit(): void {
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
      if (payload.length !== 12 + message.bodyLength) {
        throw new Error(
          `Longitud de trama inconsistente: payload=${payload.length}, ` +
            `esperado=${12 + message.bodyLength}`,
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
      });

      switch (message.messageId) {
        case 0x0100:
          this.handleRegistration(socket, state, message);
          break;
        case 0x0102:
          this.handleAuthentication(socket, state, message);
          break;
        case 0x0002:
          this.sendGeneralResponse(socket, message, 0x00, 'heartbeat');
          break;
        default:
          this.logger.warn(
            `Mensaje no manejado aún: terminal=${message.terminalId}, ` +
              `messageId=${this.formatMessage(message.messageId)}`,
          );
          this.sendGeneralResponse(socket, message, 0x00, 'no manejado aún');
      }
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
  ): void {
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
  }

  private logReceived(message: Jt808Header): void {
    this.logger.log(
      `RX terminal=${message.terminalId}, ` +
        `messageId=${this.formatMessage(message.messageId)}, ` +
        `serial=${message.serialNumber}, body=${message.bodyLength} bytes`,
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
