import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsDateString,
  MaxLength,
  MinLength,
  IsArray,
  IsNumber,
  Matches,
} from 'class-validator';

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

export class CreateUsuarioDto {
  @IsString()
  @IsNotEmpty({ message: 'El UserName es obligatorio' })
  @MaxLength(100, {
    message: 'El UserName no puede exceder los 100 caracteres',
  })
  @ApiProperty({ description: 'Nombre de usuario', example: 'usuario01' })
  userName: string;

  @IsString()
  @IsNotEmpty({ message: 'El Password es obligatorio' })
  @MinLength(6, { message: 'El Password debe tener al menos 6 caracteres' })
  @Matches(/^(?=.*\p{L})(?=.*\d)(?=.*[@$!%*?&.])[^\s]+$/u, {
    message:
      'El Password debe contener al menos una letra (UTF-8), un número y un símbolo común (@$!%*?&.)',
  })
  @ApiProperty({
    description: 'Contraseña del usuario',
    example: 'P@ssword123',
  })
  passwordHash: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Nombre del usuario',
    example: 'Juan',
  })
  nombre: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Apellido paterno',
    example: 'Pérez',
    required: true,
  })
  apellidoPaterno: string;

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

  /**
   * No enviar como archivo aquí. La URL la asigna el servicio tras subir a S3.
   * Se mantiene opcional por compatibilidad si llega una URL textual.
   */
  @IsOptional()
  @IsString()
  @ApiProperty({
    description:
      'URL de foto de perfil (asignada por el backend tras subir a S3). Preferir campo archivo fotoPerfil.',
    required: false,
  })
  fotoPerfil?: string;

  @Transform(toNumber)
  @IsInt()
  @ApiProperty({ description: 'Rol asignado', example: 2 })
  idRol: number;

  @Transform(toNumber)
  @IsInt()
  @ApiProperty({ description: 'Cliente asignado', example: 5 })
  @IsNotEmpty()
  idCliente: number;

  @Transform(toNumberArray)
  @IsNotEmpty()
  @IsArray()
  @IsNumber({}, { each: true })
  @ApiProperty({
    description: 'IDs de permisos (JSON array o CSV en multipart)',
    example: [1, 2, 3],
    type: [Number],
  })
  permisosIds: number[];
}
