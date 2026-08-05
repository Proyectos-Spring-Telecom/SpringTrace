import { Module } from '@nestjs/common';
import { CaptureLoggerService } from './capture-logger.service';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { HistoricoLoggerService } from './historico-logger.service';

@Module({
  controllers: [GatewayController],
  providers: [CaptureLoggerService, HistoricoLoggerService, GatewayService],
})
export class GatewayModule {}
