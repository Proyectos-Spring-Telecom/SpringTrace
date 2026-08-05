import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CapturePhotoDto {
  @ApiPropertyOptional({
    description: 'Canal lógico de cámara (2 = CH2 para AE-DI5052-G40PRO)',
    example: 2,
    default: 2,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  channelId?: number;

  @ApiPropertyOptional({
    description:
      '1 = guardar en SD y solicitar después con 0x8805; 0 = subida inmediata',
    enum: [0, 1],
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  saveFlag?: 0 | 1;
}
