import { Module } from '@nestjs/common';
import { SnifferService } from './sniffer.service';

@Module({
  providers: [SnifferService],
})
export class SnifferModule {}
