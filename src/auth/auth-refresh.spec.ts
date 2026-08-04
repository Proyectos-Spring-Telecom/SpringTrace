import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthTokensService } from './auth-tokens.service';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from './auth.service';
import { createHash } from 'crypto';
import * as bcrypt from 'bcrypt';

jest.mock('src/utils/correccion-hora', () => ({
  horaDesfasada: jest.fn(async () => ({ fechaActual: '2026-07-27 12:00:00' })),
}));

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));

describe('AuthTokensService', () => {
  let tokens: AuthTokensService;
  let jwtService: JwtService;

  beforeEach(() => {
    jwtService = new JwtService({
      secret: 'test-secret',
    });
    const config = {
      get: (key: string) => {
        if (key === 'JWT_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '120m';
        return undefined;
      },
    } as ConfigService;

    tokens = new AuthTokensService(jwtService, config);
  });

  it('hashRefreshToken genera SHA-256 hex de 64 chars', () => {
    const hash = tokens.hashRefreshToken('mi-refresh');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(
      createHash('sha256').update('mi-refresh').digest('hex'),
    );
  });

  it('signAccessToken incluye type=access', () => {
    const user = {
      id: 10,
      userName: 'admin@test.com',
      idCliente: 1,
      idRol: 2,
    } as any;

    const token = tokens.signAccessToken(user);
    const payload = jwtService.decode(token) as any;
    expect(payload.type).toBe('access');
    expect(payload.id).toBe(10);
    expect(payload.email).toBe('admin@test.com');
  });

  it('signRefreshToken incluye type=refresh y jti, y expira', () => {
    const { token, jti, expiresAt } = tokens.signRefreshToken(10);
    const payload = jwtService.decode(token) as any;
    expect(payload.type).toBe('refresh');
    expect(payload.jti).toBe(jti);
    expect(payload.id).toBe(10);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('JwtStrategy', () => {
  const strategy = new JwtStrategy({
    get: () => 'test-secret',
  } as ConfigService);

  it('acepta access token', () => {
    const user = strategy.validate({
      id: 1,
      email: 'a@b.com',
      idCliente: 1,
      rol: 2,
      type: 'access',
    });
    expect(user.userId).toBe(1);
    expect(user.rol).toBe(2);
  });

  it('rechaza refresh token usado como Bearer con mensaje esperado', () => {
    expect(() =>
      strategy.validate({
        id: 1,
        type: 'refresh',
        jti: 'abc',
      }),
    ).toThrow('Token de acceso inválido');
  });
});

describe('AuthService signIn / getMe / refresh / logout', () => {
  let authService: AuthService;
  let refreshSessionsRepository: any;
  let usuariosRepository: any;
  let permisosRepository: any;
  let authTokensService: AuthTokensService;
  let jwtService: JwtService;
  let dataSource: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jwtService = new JwtService({ secret: 'test-secret' });
    authTokensService = new AuthTokensService(jwtService, {
      get: (key: string) => {
        if (key === 'JWT_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '120m';
        return undefined;
      },
    } as ConfigService);

    refreshSessionsRepository = {
      save: jest.fn(async (entity) => ({ id: 100, ...entity })),
      create: jest.fn((entity) => entity),
      findOne: jest.fn(),
      update: jest.fn(),
    };

    usuariosRepository = {
      findOne: jest.fn(),
      update: jest.fn(),
    };

    permisosRepository = {
      find: jest.fn().mockResolvedValue([
        { idPermiso: 1 },
        { idPermiso: 5 },
      ]),
    };

    dataSource = {
      transaction: jest.fn(async (cb) => {
        const manager = {
          save: jest.fn(async (_entity, data) => ({ id: 200, ...data })),
          create: jest.fn((_entity, data) => data),
          update: jest.fn(),
        };
        return cb(manager);
      }),
    };

    authService = new AuthService(
      usuariosRepository,
      permisosRepository,
      {} as any,
      refreshSessionsRepository,
      jwtService,
      {} as any,
      {} as any,
      authTokensService,
      dataSource,
    );

    process.env.JWT_SECRET = 'test-secret';
  });

  it('login ok crea RefreshSessions y retorna solo token+refreshToken', async () => {
    const user = {
      id: 10,
      userName: 'admin@test.com',
      passwordHash: 'hash',
      idCliente: 1,
      idRol: 2,
      estatus: 1,
      emailConfirmado: 1,
    };
    usuariosRepository.findOne.mockResolvedValue(user);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await authService.signIn({
      userName: 'admin@test.com',
      password: 'secret',
    });

    expect(result).toEqual({
      token: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(Object.keys(result)).toEqual(['token', 'refreshToken']);
    expect(refreshSessionsRepository.save).toHaveBeenCalled();
    expect(usuariosRepository.update).toHaveBeenCalled();

    const accessPayload = jwtService.decode(result.token) as any;
    expect(accessPayload.type).toBe('access');
  });

  it('login con password incorrecta → 401 Credenciales inválidas', async () => {
    usuariosRepository.findOne.mockResolvedValue({
      id: 10,
      passwordHash: 'hash',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      authService.signIn({ userName: 'admin@test.com', password: 'bad' }),
    ).rejects.toThrow('Credenciales inválidas');
  });

  it('login con usuario inexistente / inactivo → 401 Credenciales inválidas', async () => {
    usuariosRepository.findOne.mockResolvedValue(null);

    await expect(
      authService.signIn({ userName: 'x@test.com', password: 'any' }),
    ).rejects.toThrow('Credenciales inválidas');
  });

  it('/me con access válido → mismos datos del login anterior', async () => {
    const rol = { id: 2, nombre: 'Administrador' };
    usuariosRepository.findOne.mockResolvedValue({
      id: 10,
      nombre: 'Juan',
      apellidoPaterno: 'Pérez',
      apellidoMaterno: 'López',
      idCliente: 1,
      userName: 'admin@test.com',
      telefono: '5512345678',
      ultimoLogin: '2026-07-27 12:00:00',
      fechaCreacion: '2026-01-01 10:00:00',
      fotoPerfil: 'https://img/user.png',
      estatus: 1,
      idRol2: rol,
      cliente2: {
        nombre: 'Sentinel',
        apellidoPaterno: 'SA',
        apellidoMaterno: 'CV',
        logotipo: 'https://logo.png',
      },
    });
    permisosRepository.find = jest
      .fn()
      .mockResolvedValue([{ idPermiso: 1 }, { idPermiso: 5 }]);

    const me = await authService.getMe(10);

    expect(me).toEqual({
      message: 'Perfil obtenido exitosamente',
      id: 10,
      nombre: 'Juan',
      apellidoPaterno: 'Pérez',
      apellidoMaterno: 'López',
      idCliente: 1,
      nombreCliente: 'Sentinel',
      apellidoPaternoCliente: 'SA',
      apellidoMaternoCliente: 'CV',
      logotipo: 'https://logo.png',
      telefono: '5512345678',
      ultimoLogin: '2026-07-27 12:00:00',
      fechaCreacion: '2026-01-01 10:00:00',
      fotoPerfil: 'https://img/user.png',
      userName: 'admin@test.com',
      rol,
      permisos: [{ idPermiso: 1 }, { idPermiso: 5 }],
    });
  });

  it('/me con usuario inactivo → 401', async () => {
    usuariosRepository.findOne.mockResolvedValue(null);

    await expect(authService.getMe(10)).rejects.toThrow(
      'Usuario no autorizado',
    );
  });

  it('refresh rota sesión (vieja revoked, nueva activa)', async () => {
    const user = {
      id: 10,
      userName: 'admin@test.com',
      idCliente: 1,
      idRol: 2,
      estatus: 1,
    };
    const { token: refreshToken, jti, expiresAt } =
      authTokensService.signRefreshToken(10);
    const tokenHash = authTokensService.hashRefreshToken(refreshToken);

    refreshSessionsRepository.findOne.mockResolvedValue({
      id: 50,
      idUsuario: 10,
      jti,
      tokenHash,
      expiresAt,
      revokedAt: null,
      replacedById: null,
    });
    usuariosRepository.findOne.mockResolvedValue(user);

    const result = await authService.refreshTokens({ refreshToken });

    expect(result.token).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.refreshToken).not.toBe(refreshToken);
    expect(dataSource.transaction).toHaveBeenCalled();

    const accessPayload = jwtService.decode(result.token) as any;
    expect(accessPayload.type).toBe('access');
  });

  it('refresh con token ya revocado falla', async () => {
    const { token: refreshToken, jti, expiresAt } =
      authTokensService.signRefreshToken(10);

    refreshSessionsRepository.findOne.mockResolvedValue({
      id: 50,
      idUsuario: 10,
      jti,
      tokenHash: authTokensService.hashRefreshToken(refreshToken),
      expiresAt,
      revokedAt: new Date(),
      replacedById: 99,
    });

    await expect(
      authService.refreshTokens({ refreshToken }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('logout revoca sesión cuando hash coincide', async () => {
    const { token: refreshToken, jti } =
      authTokensService.signRefreshToken(10);

    refreshSessionsRepository.findOne.mockResolvedValue({
      id: 50,
      idUsuario: 10,
      jti,
      tokenHash: authTokensService.hashRefreshToken(refreshToken),
      revokedAt: null,
    });

    const result = await authService.logoutRefresh({ refreshToken });
    expect(result).toEqual({ message: 'Sesión cerrada' });
    expect(refreshSessionsRepository.update).toHaveBeenCalledWith(50, {
      revokedAt: expect.any(Date),
    });
  });

  it('logout con token inválido igual responde éxito', async () => {
    const result = await authService.logoutRefresh({
      refreshToken: 'token-basura',
    });
    expect(result).toEqual({ message: 'Sesión cerrada' });
  });
});
