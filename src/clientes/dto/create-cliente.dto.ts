import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsInt,
  MaxLength,
  IsEmail,
  IsIn,
} from 'class-validator';

const toNumber = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return value;
  return Number(value);
};

export class CreateClienteDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return 1;
    return Number(value);
  })
  @IsInt({ message: 'IdPadre debe ser un número entero' })
  @ApiProperty({
    description: 'Id del cliente padre. Si viene nulo o vacío, se asigna 1.',
    example: 1,
    required: false,
    default: 1,
  })
  idPadre?: number = 1;

  @IsString()
  @IsNotEmpty({ message: 'El RFC es obligatorio' })
  @MaxLength(16, { message: 'El RFC no puede exceder los 16 caracteres' })
  @ApiProperty({ description: 'RFC del cliente', example: 'XAXX010101000' })
  rfc: string;

  @Transform(toNumber)
  @IsInt({ message: 'TipoPersona debe ser un número entero (1=Física, 2=Moral)' })
  @IsIn([1, 2], { message: 'TipoPersona debe ser 1 (Física) o 2 (Moral)' })
  @ApiProperty({
    description: 'Tipo de persona (1=Física, 2=Moral)',
    example: 1,
  })
  tipoPersona: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Nombre del cliente',
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
    required: false,
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
    example: '5551234567',
    required: false,
  })
  telefono?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Debe ser un correo válido' })
  @ApiProperty({
    description: 'Correo electrónico',
    example: 'cliente@correo.com',
    required: false,
  })
  correo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({
    description: 'Sitio web',
    example: 'https://miempresa.com',
    required: false,
  })
  sitioWeb?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiProperty({ required: false })
  estado?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiProperty({ required: false })
  municipio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({ required: false })
  colonia?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({ required: false })
  calle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiProperty({ required: false })
  entreCalles?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiProperty({ required: false })
  numeroExterior?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiProperty({ required: false })
  numeroInterior?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  @ApiProperty({ required: false })
  cp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiProperty({ required: false })
  nombreEncargado?: string;

  @IsOptional()
  @IsString()
  @MaxLength(14)
  @ApiProperty({ required: false })
  telefonoEncargado?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Debe ser un correo válido' })
  @ApiProperty({ required: false })
  correoEncargado?: string;

  /**
   * URLs asignadas por el backend tras subir a S3.
   * En multipart enviar como archivos con el mismo nombre de campo.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiProperty({
    required: false,
    description: 'URL (asignada por backend). Preferir archivo multipart.',
  })
  constanciaSituacionFiscal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiProperty({
    required: false,
    description: 'URL (asignada por backend). Preferir archivo multipart.',
  })
  comprobanteDomicilio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiProperty({
    required: false,
    description: 'URL (asignada por backend). Preferir archivo multipart.',
  })
  actaConstitutiva?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiProperty({
    required: false,
    description: 'URL (asignada por backend). Preferir archivo multipart logotipo.',
  })
  logotipo?: string;
}
