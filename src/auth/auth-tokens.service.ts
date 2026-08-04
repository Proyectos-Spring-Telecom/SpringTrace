import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { Usuarios } from 'src/entities/Usuarios';

export type AccessTokenPayload = {
  id: number;
  email: string;
  idCliente: number | null;
  rol: number | null;
  type: 'access';
};

export type RefreshTokenPayload = {
  id: number;
  type: 'refresh';
  jti: string;
};

@Injectable()
export class AuthTokensService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /** SHA-256 del refresh JWT en hexadecimal (64 chars). */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  buildAccessPayload(user: Usuarios): AccessTokenPayload {
    return {
      id: Number(user.id),
      email: user.userName,
      idCliente: user.idCliente != null ? Number(user.idCliente) : null,
      rol: user.idRol != null ? Number(user.idRol) : null,
      type: 'access',
    };
  }

  signAccessToken(user: Usuarios): string {
    const payload = this.buildAccessPayload(user);
    return this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_EXPIRES_IN') as any,
    });
  }

  /**
   * Emite refresh JWT (type=refresh + jti UUID).
   * expiresAt se toma del claim exp del token firmado.
   */
  signRefreshToken(userId: number): {
    token: string;
    jti: string;
    expiresAt: Date;
  } {
    const jti = randomUUID();
    const payload: RefreshTokenPayload = {
      id: Number(userId),
      type: 'refresh',
      jti,
    };

    const token = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN') as any,
    });

    const decoded = this.jwtService.decode(token) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);

    return { token, jti, expiresAt };
  }
}
