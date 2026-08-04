import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  ParseIntPipe,
  Request,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import { UsuariosService } from './usuarios.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { UpdateUsuarioContrasena } from './dto/update-usuario-contrasena.dto';
import { JwtAuthGuard } from 'src/guard/jwt-auth.guard';
import { RolesGuard } from 'src/guard/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { ApiResponseCommon, ApiCrudResponse } from 'src/common/ApiResponse';
import { usuariosFileFieldsInterceptor } from './usuarios-upload.interceptor';

@ApiTags('Usuarios')
@ApiBearerAuth('bearer-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles() // Todos los roles pueden acceder por defecto
@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) { }

  // ==================== POST ====================

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(usuariosFileFieldsInterceptor())
  @ApiOperation({
    summary: 'Crear un nuevo usuario',
    description:
      'Registra un nuevo usuario. La foto de perfil (opcional) se envía como archivo multipart en el campo fotoPerfil y se sube a S3.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'userName',
        'passwordHash',
        'nombre',
        'apellidoPaterno',
        'idRol',
        'idCliente',
        'permisosIds',
      ],
      properties: {
        userName: { type: 'string', example: 'usuario01' },
        passwordHash: { type: 'string', example: 'P@ssword123' },
        nombre: { type: 'string', example: 'Juan' },
        apellidoPaterno: { type: 'string', example: 'Pérez' },
        apellidoMaterno: { type: 'string', example: 'López' },
        telefono: { type: 'string', example: '5512345678' },
        idRol: { type: 'number', example: 2 },
        idCliente: { type: 'number', example: 5 },
        permisosIds: {
          type: 'string',
          example: '[1,2,3]',
          description: 'JSON array o CSV de IDs de permisos',
        },
        fotoPerfil: {
          type: 'string',
          format: 'binary',
          description: 'Imagen de perfil (PNG/JPG/JPEG), opcional',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Usuario creado exitosamente',
  })
  @ApiResponse({
    status: 400,
    description: 'Datos inválidos',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado',
  })
  @ApiResponse({
    status: 403,
    description:
      'Acceso denegado - Solo SuperAdministrador o Administrador pueden crear usuarios',
  })
  async createUsuario(
    @Body() createUsuarioDto: CreateUsuarioDto,
    @UploadedFiles()
    files: { fotoPerfil?: Express.Multer.File[] },
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    const fileFotoPerfil = files?.fotoPerfil?.[0];
    return await this.usuariosService.createUsuario(
      createUsuarioDto,
      idUser,
      fileFotoPerfil,
    );
  }

  // ==================== GET ====================

  @Get('list')
  @ApiOperation({
    summary: 'Obtener lista completa de usuarios',
    description: 'Obtiene todos los usuarios sin paginación según el rol y permisos'
  })
  @ApiResponse({
    status: 200,
    description: 'Lista completa de usuarios obtenida exitosamente',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado'
  })
  async findAllList(@Request() req): Promise<ApiResponseCommon> {
    const idCliente = req.user.idCliente;
    const rol = req.user.rol;
    return await this.usuariosService.getAllListUsuarios(+idCliente, +rol);
  }

  @Get('list/cliente/:id')
  @ApiOperation({
    summary: 'Obtener usuarios por cliente específico',
    description: 'Obtiene la lista de usuarios asociados a un cliente específico'
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del cliente',
    example: 1
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de usuarios del cliente obtenida exitosamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Cliente no encontrado'
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado'
  })
  async findAllListUsuarioCliente(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiResponseCommon> {
    const idCliente = req.user.idCliente;
    return await this.usuariosService.getAllListUsuariosCliente(id, +idCliente);
  }

  @Get(':page/:limit')
  @ApiOperation({
    summary: 'Obtener usuarios con paginación',
    description: 'Obtiene una lista paginada de usuarios según los parámetros especificados'
  })
  @ApiParam({
    name: 'page',
    type: 'number',
    description: 'Número de página',
    example: 1
  })
  @ApiParam({
    name: 'limit',
    type: 'number',
    description: 'Cantidad de registros por página',
    example: 10
  })
  @ApiResponse({
    status: 200,
    description: 'Usuarios obtenidos exitosamente con paginación',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado'
  })
  async findAll(
    @Param('page', ParseIntPipe) page: number,
    @Param('limit', ParseIntPipe) limit: number,
    @Request() req,
  ): Promise<ApiResponseCommon> {
    const idCliente = req.user.idCliente;
    const rol = req.user.rol;
    const idUser = req.user.userId;
    return await this.usuariosService.getAllUsuario(
      +idUser,
      +idCliente,
      +rol,
      page,
      limit,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener usuario por ID',
    description: 'Obtiene la información detallada de un usuario específico por su ID'
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del usuario',
    example: 1
  })
  @ApiResponse({
    status: 200,
    description: 'Usuario encontrado exitosamente'
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado'
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado'
  })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Request() req
  ) {
    const idCliente = req.user.idCliente;
    const rol = req.user.rol;
    return this.usuariosService.getUsuarioByID(+id, +idCliente, +rol);
  }

  // ==================== PATCH ====================

  @Patch('estatus/:id')
  @ApiOperation({
    summary: 'Cambiar estatus del usuario',
    description:
      'Alterna el estatus del usuario: si está activo (1) pasa a inactivo (0) y viceversa. No requiere body.',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del usuario',
    example: 1,
  })
  @ApiResponse({
    status: 200,
    description: 'Estatus actualizado exitosamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado',
  })
  async changeUsuarioEstatus(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.usuariosService.updateUsuarioEstatus(id, idUser);
  }

  @Patch('actualizar/contrasena/:id')
  @ApiOperation({
    summary: 'Cambiar contraseña de usuario',
    description:
      'Actualiza la contraseña del usuario autenticado. El :id del path debe coincidir con el userId del token.',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del usuario (debe ser el mismo del token JWT)',
    example: 1,
  })
  @ApiBody({ type: UpdateUsuarioContrasena })
  @ApiResponse({
    status: 200,
    description: 'Contraseña actualizada exitosamente',
  })
  @ApiResponse({
    status: 400,
    description: 'Contraseña inválida',
  })
  @ApiResponse({
    status: 403,
    description: 'Acceso denegado - Solo puedes actualizar tu propia contraseña',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado',
  })
  async updateContrasena(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUsuarioContrasena: UpdateUsuarioContrasena,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.usuariosService.updateContrasena(
      id,
      idUser,
      updateUsuarioContrasena,
    );
  }

  @Patch(':id')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(usuariosFileFieldsInterceptor())
  @ApiOperation({
    summary: 'Actualizar datos del usuario',
    description:
      'Actualiza un usuario. Si llega un archivo en fotoPerfil, se sube a S3, se actualiza la URL y se elimina la imagen anterior en segundo plano.',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del usuario',
    example: 1,
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', example: 'Juan' },
        apellidoPaterno: { type: 'string', example: 'Pérez' },
        apellidoMaterno: { type: 'string', example: 'López' },
        telefono: { type: 'string', example: '5512345678' },
        idRol: { type: 'number', example: 2 },
        idCliente: { type: 'number', example: 5 },
        permisosIds: {
          type: 'string',
          example: '[1,2,3]',
          description: 'JSON array o CSV de IDs de permisos',
        },
        fotoPerfil: {
          type: 'string',
          format: 'binary',
          description: 'Nueva imagen de perfil (PNG/JPG/JPEG), opcional',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Usuario actualizado exitosamente',
  })
  @ApiResponse({
    status: 400,
    description: 'Datos inválidos',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado',
  })
  async updateUsuario(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUsuarioDto: UpdateUsuarioDto,
    @UploadedFiles()
    files: { fotoPerfil?: Express.Multer.File[] },
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    const fileFotoPerfil = files?.fotoPerfil?.[0];
    return await this.usuariosService.updateUsuario(
      id,
      updateUsuarioDto,
      idUser,
      fileFotoPerfil,
    );
  }

  // ==================== DELETE ====================

  @Delete(':id')
  @Roles() // Solo SuperAdministrador puede eliminar usuarios
  @ApiOperation({
    summary: 'Eliminar usuario',
    description: 'Elimina un usuario del sistema'
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del usuario a eliminar',
    example: 1
  })
  @ApiResponse({
    status: 200,
    description: 'Usuario eliminado exitosamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado'
  })
  @ApiResponse({
    status: 400,
    description: 'No se puede eliminar el usuario'
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado'
  })
  @ApiResponse({
    status: 403,
    description: 'Acceso denegado - Solo SuperAdministrador puede eliminar usuarios'
  })
  async deleteUsuario(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.usuariosService.deleteUsuario(id, idUser);
  }
}