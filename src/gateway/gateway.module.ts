import { Module } from '@nestjs/common';
import { CaptureLoggerService } from './capture-logger.service';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { HistoricoLoggerService } from './historico-logger.service';
import { MediaServerService } from './media-server.service';

@Module({
  controllers: [GatewayController],
  providers: [
    CaptureLoggerService,
    HistoricoLoggerService,
    MediaServerService,
    GatewayService,
  ],
})
export class GatewayModule {}
