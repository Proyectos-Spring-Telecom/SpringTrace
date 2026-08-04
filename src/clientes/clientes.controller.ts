import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
  ParseIntPipe,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { ClientesService } from './clientes.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';
import { JwtAuthGuard } from 'src/guard/jwt-auth.guard';
import { RolesGuard } from 'src/guard/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { ApiCrudResponse, ApiResponseCommon } from 'src/common/ApiResponse';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { clientesFileFieldsInterceptor } from './clientes-upload.interceptor';

@ApiTags('Clientes')
@ApiBearerAuth('bearer-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(1, 2, 3)
@Controller('clientes')
export class ClientesController {
  constructor(private readonly clientesService: ClientesService) {}

  // ==================== POST ====================

  @Post()
  @Roles(1)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(clientesFileFieldsInterceptor())
  @ApiOperation({
    summary: 'Crear un nuevo cliente',
    description:
      'Crea un cliente. Archivos opcionales → S3 folder clientes: constanciaSituacionFiscal, comprobanteDomicilio, actaConstitutiva (PNG/JPG/PDF) y logotipo (PNG/JPG).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['rfc', 'tipoPersona'],
      properties: {
        idPadre: { type: 'number', example: 1 },
        rfc: { type: 'string', example: 'XAXX010101000' },
        tipoPersona: { type: 'number', example: 1 },
        nombre: { type: 'string', example: 'Juan' },
        apellidoPaterno: { type: 'string', example: 'Pérez' },
        apellidoMaterno: { type: 'string', example: 'López' },
        telefono: { type: 'string', example: '5551234567' },
        correo: { type: 'string', example: 'cliente@correo.com' },
        sitioWeb: { type: 'string' },
        estado: { type: 'string' },
        municipio: { type: 'string' },
        colonia: { type: 'string' },
        calle: { type: 'string' },
        entreCalles: { type: 'string' },
        numeroExterior: { type: 'string' },
        numeroInterior: { type: 'string' },
        cp: { type: 'string' },
        nombreEncargado: { type: 'string' },
        telefonoEncargado: { type: 'string' },
        correoEncargado: { type: 'string' },
        constanciaSituacionFiscal: {
          type: 'string',
          format: 'binary',
          description: 'PDF/imagen, opcional',
        },
        comprobanteDomicilio: {
          type: 'string',
          format: 'binary',
          description: 'PDF/imagen, opcional',
        },
        actaConstitutiva: {
          type: 'string',
          format: 'binary',
          description: 'PDF/imagen, opcional',
        },
        logotipo: {
          type: 'string',
          format: 'binary',
          description: 'PNG/JPG, opcional',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Cliente creado exitosamente' })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({
    status: 403,
    description: 'Acceso denegado - Solo SuperAdministrador puede crear clientes',
  })
  async createCliente(
    @Body() createClienteDto: CreateClienteDto,
    @UploadedFiles()
    files: {
      constanciaSituacionFiscal?: Express.Multer.File[];
      comprobanteDomicilio?: Express.Multer.File[];
      actaConstitutiva?: Express.Multer.File[];
      logotipo?: Express.Multer.File[];
    },
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.clientesService.createCliente(
      createClienteDto,
      idUser,
      {
        constanciaSituacionFiscal: files?.constanciaSituacionFiscal?.[0],
        comprobanteDomicilio: files?.comprobanteDomicilio?.[0],
        actaConstitutiva: files?.actaConstitutiva?.[0],
        logotipo: files?.logotipo?.[0],
      },
    );
  }

  // ==================== GET ====================

  @Get('list')
  @ApiOperation({
    summary: 'Obtener lista completa de clientes',
    description:
      'Obtiene todos los clientes según el rol y permisos del usuario',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de clientes obtenida exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  async getAllListClientes(@Request() req): Promise<ApiResponseCommon> {
    const idCliente = req.user.idCliente;
    const idUser = req.user.userId;
    const rol = req.user.rol;
    return this.clientesService.getAllListClientes(+idUser, +idCliente, +rol);
  }

  @Get('list/:cliente')
  @ApiOperation({
    summary: 'Obtener lista de clientes por ID de cliente',
    description:
      'Obtiene todos los clientes filtrados por un ID de cliente específico',
  })
  @ApiParam({
    name: 'cliente',
    type: 'number',
    description: 'ID del cliente',
    example: 1,
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de clientes obtenida exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  async getAllListClientesId(
    @Param('cliente', ParseIntPipe) idCliente: number,
    @Request() req,
  ): Promise<ApiResponseCommon> {
    const idUser = req.user.userId;
    const rol = req.user.rol;
    return this.clientesService.getAllListClientesId(+idUser, +idCliente, +rol);
  }

  @Get(':page/:limit')
  @ApiOperation({
    summary: 'Obtener clientes con paginación',
    description:
      'Obtiene una lista paginada de clientes según los parámetros especificados',
  })
  @ApiParam({
    name: 'page',
    type: 'number',
    description: 'Número de página',
    example: 1,
  })
  @ApiParam({
    name: 'limit',
    type: 'number',
    description: 'Cantidad de registros por página',
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'Clientes obtenidos exitosamente con paginación',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  async getAllClientes(
    @Param('page', ParseIntPipe) page: number,
    @Param('limit', ParseIntPipe) limit: number,
    @Request() req,
  ): Promise<ApiResponseCommon> {
    const idCliente = req.user.idCliente;
    const idUser = req.user.userId;
    const rol = req.user.rol;
    return this.clientesService.getAllClientes(
      +idUser,
      +idCliente,
      +rol,
      page,
      limit,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener un cliente específico',
    description: 'Obtiene la información detallada de un cliente por su ID',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del cliente',
    example: 1,
  })
  @ApiResponse({ status: 200, description: 'Cliente obtenido exitosamente' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  async getOneCliente(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.clientesService.getOneCliente(id);
  }

  // ==================== PATCH ====================

  @Patch('estatus/:id')
  @ApiOperation({
    summary: 'Cambiar estatus de un cliente',
    description:
      'Alterna el estatus del cliente: si está activo (1) pasa a inactivo (0) y viceversa. Aplica también a clientes hijos. No requiere body.',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del cliente',
    example: 1,
  })
  @ApiResponse({ status: 200, description: 'Estatus actualizado exitosamente' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  async updateEstatusClientes(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return this.clientesService.updateClienteStatus(id, idUser);
  }

  @Patch(':id')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(clientesFileFieldsInterceptor())
  @ApiOperation({
    summary: 'Actualizar datos de un cliente',
    description:
      'Actualiza un cliente. Si llegan archivos de documentos, se suben a S3 (folder clientes) y se reemplazan las URLs anteriores.',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del cliente',
    example: 1,
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        idPadre: { type: 'number', example: 1 },
        rfc: { type: 'string', example: 'XAXX010101000' },
        tipoPersona: { type: 'number', example: 1 },
        nombre: { type: 'string', example: 'Juan' },
        apellidoPaterno: { type: 'string', example: 'Pérez' },
        apellidoMaterno: { type: 'string', example: 'López' },
        telefono: { type: 'string', example: '5551234567' },
        correo: { type: 'string', example: 'cliente@correo.com' },
        sitioWeb: { type: 'string' },
        estado: { type: 'string' },
        municipio: { type: 'string' },
        colonia: { type: 'string' },
        calle: { type: 'string' },
        entreCalles: { type: 'string' },
        numeroExterior: { type: 'string' },
        numeroInterior: { type: 'string' },
        cp: { type: 'string' },
        nombreEncargado: { type: 'string' },
        telefonoEncargado: { type: 'string' },
        correoEncargado: { type: 'string' },
        estatus: { type: 'number', example: 1 },
        constanciaSituacionFiscal: {
          type: 'string',
          format: 'binary',
          description: 'PDF/imagen, opcional',
        },
        comprobanteDomicilio: {
          type: 'string',
          format: 'binary',
          description: 'PDF/imagen, opcional',
        },
        actaConstitutiva: {
          type: 'string',
          format: 'binary',
          description: 'PDF/imagen, opcional',
        },
        logotipo: {
          type: 'string',
          format: 'binary',
          description: 'PNG/JPG, opcional',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Cliente actualizado exitosamente' })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  async updateCliente(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @Body() updateClienteDto: UpdateClienteDto,
    @UploadedFiles()
    files: {
      constanciaSituacionFiscal?: Express.Multer.File[];
      comprobanteDomicilio?: Express.Multer.File[];
      actaConstitutiva?: Express.Multer.File[];
      logotipo?: Express.Multer.File[];
    },
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.clientesService.updateCliente(
      id,
      idUser,
      updateClienteDto,
      {
        constanciaSituacionFiscal: files?.constanciaSituacionFiscal?.[0],
        comprobanteDomicilio: files?.comprobanteDomicilio?.[0],
        actaConstitutiva: files?.actaConstitutiva?.[0],
        logotipo: files?.logotipo?.[0],
      },
    );
  }

  // ==================== DELETE ====================

  @Delete(':id')
  @Roles(1)
  @ApiOperation({
    summary: 'Eliminar un cliente',
    description: 'Elimina un cliente del sistema',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del cliente a eliminar',
    example: 1,
  })
  @ApiResponse({ status: 200, description: 'Cliente eliminado exitosamente' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({
    status: 403,
    description: 'Acceso denegado - Solo SuperAdministrador puede eliminar clientes',
  })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  async removeClientes(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    const idCliente = req.user.idCliente;
    return await this.clientesService.removeCliente(id, idUser, +idCliente);
  }
}
