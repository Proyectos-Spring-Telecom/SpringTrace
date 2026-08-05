import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CapturePhotoDto } from './dto/capture-photo.dto';
import { FetchMediaDto } from './dto/fetch-media.dto';
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
    return this.gatewayService.requestPhotoCapture(
      body.channelId ?? 2,
      body.saveFlag ?? 1,
    );
  }

  @Get('status')
  @ApiOperation({
    summary: 'Consultar sesiones JT808, colas y multimedia pendientes',
  })
  status() {
    return this.gatewayService.getStatus();
  }

  @Get('media/list')
  @ApiOperation({
    summary: 'Consultar imágenes almacenadas en la dashcam (0x8802/0x0802)',
  })
  mediaList() {
    return this.gatewayService.queryStoredMedia();
  }

  @Post('media/fetch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Solicitar descarga de un multimedia almacenado (0x8805)',
  })
  mediaFetch(@Body() body: FetchMediaDto) {
    return this.gatewayService.requestMediaFetch(body.multimediaId);
  }
}
