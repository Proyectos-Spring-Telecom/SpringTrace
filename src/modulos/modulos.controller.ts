import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Put,
  Request,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ModulosService } from './modulos.service';
import { CreateModuloDto } from './dto/create-modulo.dto';
import { UpdateModuloDto } from './dto/update-modulo.dto';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { ApiCrudResponse, ApiResponseCommon } from 'src/common/ApiResponse';
import { JwtAuthGuard } from 'src/guard/jwt-auth.guard';
import { RolesGuard } from 'src/guard/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';

@ApiTags('Modulos')
@ApiBearerAuth('bearer-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(1, 2, 3) // Todos los roles pueden acceder por defecto
@Controller('modulos')
export class ModulosController {
  constructor(private readonly modulosService: ModulosService) {}

  @Post()
  @Roles(1) // Solo SuperAdministrador puede crear módulos
  async create(
    @Body() createModuloDto: CreateModuloDto,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.modulosService.create(createModuloDto, idUser);
  }

  @Get('list')
  findAllList(): Promise<ApiResponseCommon> {
    return this.modulosService.findAllList();
  }

  @Get(':page/:limit')
  findAll(
    @Param('page', ParseIntPipe) page: number,
    @Param('limit', ParseIntPipe) limit: number,
  ): Promise<ApiResponseCommon> {
    return this.modulosService.findAll(page, limit);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.modulosService.findOne(+id);
  }

  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateModuloDto: UpdateModuloDto,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.modulosService.update(id, updateModuloDto, idUser);
  }

  @Patch(':id/estatus')
  @ApiOperation({
    summary: 'Cambiar estatus de un módulo',
    description:
      'Alterna el estatus del módulo: si está activo (1) pasa a inactivo (0) y viceversa. No requiere body.',
  })
  @ApiParam({
    name: 'id',
    type: 'number',
    description: 'ID del módulo',
    example: 1,
  })
  @ApiResponse({ status: 200, description: 'Estatus actualizado exitosamente' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Módulo no encontrado' })
  async updateModuloEstatus(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.modulosService.updateModulosStatus(id, idUser);
  }

  @Delete(':id')
  @Roles(1) // Solo SuperAdministrador puede eliminar módulos
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
  ): Promise<ApiCrudResponse> {
    const idUser = req.user.userId;
    return await this.modulosService.deleteModulo(id, idUser);
  }
}
