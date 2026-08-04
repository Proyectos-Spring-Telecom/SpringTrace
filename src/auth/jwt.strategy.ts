import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Solo tokens type=access pueden autorizar rutas protegidas.
 * Un refresh token usado como Bearer → 401.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  validate(payload: any) {
    if (payload?.type !== 'access') {
      throw new UnauthorizedException('Token de acceso inválido');
    }

    return {
      userId: typeof payload.id === 'string' ? parseInt(payload.id, 10) : payload.id,
      email: payload.email,
      idCliente:
        typeof payload.idCliente === 'string'
          ? parseInt(payload.idCliente, 10)
          : payload.idCliente,
      rol:
        typeof payload.rol === 'string'
          ? parseInt(payload.rol, 10)
          : payload.rol,
    };
  }
}
