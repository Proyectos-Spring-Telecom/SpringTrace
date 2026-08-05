import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class StartVideoDto {
  @ApiPropertyOptional({ description: 'Canal lógico (1 = CH1)', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  channelId?: number;

  @ApiPropertyOptional({
    description: '0=main stream, 1=sub-stream',
    enum: [0, 1],
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  streamType?: 0 | 1;

  @ApiPropertyOptional({
    description: '0=audio+video, 1=solo video',
    enum: [0, 1],
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  dataType?: 0 | 1;

  @ApiPropertyOptional({
    description:
      'Duración desde que conecta al puerto media hasta el auto-corte',
    default: 30,
    minimum: 1,
    maximum: 300,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  durationSeconds?: number;
}
