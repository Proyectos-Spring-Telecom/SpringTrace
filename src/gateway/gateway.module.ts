import { Module } from '@nestjs/common';
import { CaptureLoggerService } from './capture-logger.service';
import { GatewayService } from './gateway.service';

@Module({
  providers: [CaptureLoggerService, GatewayService],
})
export class GatewayModule {}
