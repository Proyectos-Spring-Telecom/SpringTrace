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
import { StartVideoDto } from './dto/start-video.dto';
import { GatewayService } from './gateway.service';

/**
 * Endpoints de prueba sin JWT para JT808/JT1078.
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

  @Post('video/start')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Solicitar video en tiempo real JT1078 (0x9101)',
    description:
      'Indica a la cámara que abra un stream TCP hacia GATEWAY_MEDIA_IP:GATEWAY_MEDIA_PORT',
  })
  videoStart(@Body() body: StartVideoDto = {}) {
    return this.gatewayService.requestVideoStart({
      channelId: body.channelId ?? 1,
      streamType: body.streamType ?? 0,
      dataType: body.dataType ?? 1,
      durationSeconds: body.durationSeconds ?? 30,
    });
  }

  @Post('video/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Detener transmisión de video (0x9102 cierre)',
  })
  videoStop(@Body() body: StartVideoDto = {}) {
    return this.gatewayService.requestVideoStop(body.channelId ?? 1);
  }

  @Get('video/status')
  @ApiOperation({
    summary: 'Estado del servidor media JT1078 y última solicitud 0x9101',
  })
  videoStatus() {
    return this.gatewayService.getVideoStatus();
  }
}
