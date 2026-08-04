import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/** Convierte strings de multipart a número */
const toNumber = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return value;
  return Number(value);
};

/** Convierte permisosIds desde JSON string, CSV o array (multipart) */
const toNumberArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return value;
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map(Number);
    }
  }
  return value;
};

export class UpdateUsuarioDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Nombre del usuario',
    example: 'Juan',
    required: false,
  })
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Apellido paterno',
    example: 'Pérez',
    required: true,
  })
  apellidoPaterno?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Apellido materno',
    example: 'López',
    required: false,
  })
  apellidoMaterno?: string;

  @IsOptional()
  @IsString()
  @MaxLength(14)
  @ApiProperty({
    description: 'Teléfono',
    example: '5512345678',
    required: false,
  })
  telefono?: string;

  @IsOptional()
  @IsDateString()
  @ApiProperty({ description: 'Actualización de contraseña', required: false })
  actualizacionPassword?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({
    description:
      'URL de foto de perfil (asignada por el backend tras subir a S3). Preferir campo archivo fotoPerfil.',
    required: false,
  })
  fotoPerfil?: string;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @ApiProperty({ description: 'Rol asignado', example: 2 })
  idRol?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @ApiProperty({ description: 'Cliente asignado', example: 5 })
  idCliente?: number;

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsNumber({}, { each: true })
  @ApiProperty({
    description: 'IDs de permisos (JSON array o CSV en multipart)',
    example: [1, 2, 3],
    type: [Number],
    required: false,
  })
  permisosIds?: number[];
}
