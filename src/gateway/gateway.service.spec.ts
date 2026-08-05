import { ConfigService } from '@nestjs/config';
import { CaptureLoggerService } from './capture-logger.service';
import { GatewayService } from './gateway.service';
import { HistoricoLoggerService } from './historico-logger.service';
import { MediaServerService } from './media-server.service';

describe('GatewayService session queue', () => {
  it('encola captura por terminalId cuando no hay socket autenticado', () => {
    const config = {
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    } as ConfigService;
    const captureLogger = {
      logFrame: jest.fn(),
    } as unknown as CaptureLoggerService;
    const historicoLogger = {
      logLocation: jest.fn(),
    } as unknown as HistoricoLoggerService;
    const mediaServer = {
      expectConnection: jest.fn(),
      stopCapture: jest.fn(),
      getStatus: jest.fn().mockReturnValue({
        listening: false,
        port: 9002,
        activeConnection: false,
        packets: 0,
        bytes: 0,
        jt1078MarkerSeen: false,
      }),
    } as unknown as MediaServerService;
    const service = new GatewayService(
      config,
      captureLogger,
      historicoLogger,
      mediaServer,
    );

    const result = service.requestPhotoCapture();
    const status = service.getStatus();

    expect(result).toMatchObject({
      status: 'queued',
      terminalId: '007773050481',
      channelId: 2,
      saveFlag: 1,
      platformSerial: null,
    });
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      terminalId: '007773050481',
      authenticated: false,
      queuedCommands: 1,
      pendingMultimedia: [],
    });
  });
});
