import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CapturePhotoDto } from './dto/capture-photo.dto';
import { GatewayService } from './gateway.service';

/**
 * Endpoint de prueba sin JWT: facilita disparar capturas desde curl
 * mientras se valida el soporte 0x8801 de la dashcam.
 */
@ApiTags('Gateway JT808')
@Controller('gateway')
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Post('capture')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Solicitar captura de foto a la dashcam conectada',
    description:
      'Envía el comando JT808 0x8801. Sin autenticación JWT (solo pruebas).',
  })
  capture(@Body() body: CapturePhotoDto) {
    return this.gatewayService.requestPhotoCapture(body.channelId ?? 1);
  }
}
