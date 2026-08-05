import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class FetchMediaDto {
  @ApiProperty({
    description: 'ID DWORD reportado por GET /gateway/media/list',
    example: 1002,
  })
  @IsInt()
  @Min(1)
  @Max(0xffffffff)
  multimediaId: number;
}
