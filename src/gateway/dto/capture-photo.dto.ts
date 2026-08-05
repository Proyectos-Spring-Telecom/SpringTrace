import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CapturePhotoDto {
  @ApiPropertyOptional({
    description: 'Canal lógico de cámara (1 = frontal CH1)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  channelId?: number;
}
