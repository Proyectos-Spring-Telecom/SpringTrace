import { Module } from '@nestjs/common';
import { CaptureLoggerService } from './capture-logger.service';
import { GatewayService } from './gateway.service';
import { HistoricoLoggerService } from './historico-logger.service';

@Module({
  providers: [CaptureLoggerService, HistoricoLoggerService, GatewayService],
})
export class GatewayModule {}
