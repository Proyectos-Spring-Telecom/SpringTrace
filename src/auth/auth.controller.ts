import {
  Controller,
  Post,
  Body,
  HttpCode,
  UseGuards,
  Get,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginAuthDto } from './dto/login-auth.dto';
import { LoginAuthConfirmacionDto } from './dto/login-confirmacion.dto';
import { LoginAuthResetDto } from './dto/login-recuperacion.dto';
import { JwtAuthGuard } from 'src/guard/jwt-auth.guard';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@ApiTags('Autenticación')
@ApiBearerAuth('bearer-token')
@Controller('login')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('usuario/recuperar/acceso')
  async email(@Body() loginAuthConfirmacionDto: LoginAuthConfirmacionDto) {
    return await this.authService.recuperarContrasena(loginAuthConfirmacionDto);
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login',
    description:
      'Autentica al usuario y emite access + refresh. Respuesta: { token, refreshToken }. El perfil se obtiene en GET /login/me.',
  })
  @ApiResponse({
    status: 200,
    description: 'Login exitoso',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  async login(@Body() loginAuthDto: LoginAuthDto) {
    return this.authService.signIn(loginAuthDto);
  }

  @Get('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Perfil del usuario autenticado',
    description:
      'Devuelve perfil + permisos. El userId se toma del access token (req.user.userId).',
  })
  @ApiResponse({ status: 200, description: 'Perfil del usuario' })
  @ApiResponse({ status: 401, description: 'No autorizado / access inválido' })
  async me(@Request() req) {
    return this.authService.getMe(Number(req.user.userId));
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotar refresh token',
    description:
      'Valida el refresh JWT, rota la sesión (revoca la anterior) y emite nuevos tokens.',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({ status: 200, description: 'Nuevos token y refreshToken' })
  @ApiResponse({
    status: 401,
    description: 'Refresh inválido, expirado o revocado',
  })
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshTokens(dto);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cerrar sesión (revocar refresh)',
    description:
      'Revoca la sesión de refresh de forma idempotente. Siempre responde éxito.',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({ status: 200, description: 'Sesión cerrada' })
  async logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logoutRefresh(dto);
  }

  @Post('cambiar/accesso')
  @UseGuards(JwtAuthGuard)
  async resetPassword(@Body() loginAuthResetDto: LoginAuthResetDto) {
    return await this.authService.resetPassword(loginAuthResetDto);
  }
}
