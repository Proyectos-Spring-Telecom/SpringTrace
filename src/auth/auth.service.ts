import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Usuarios } from 'src/entities/Usuarios';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { LoginAuthDto } from './dto/login-auth.dto';
import { UsuariosPermisos } from 'src/entities/UsuariosPermisos';
import { MailService } from 'src/mail/mail.service';
import { LoginAuthConfirmacionDto } from './dto/login-confirmacion.dto';
import { LoginAuthResetDto } from './dto/login-recuperacion.dto';
import { BitacoraLoggerService } from 'src/bitacora/bitacora.service';
import { EstatusEnumBitcora } from 'src/common/ApiResponse';
import { CodigoAutenticacion } from 'src/entities/CodigoAutenticacion';
import { EstatusEnum, TipoCodigoAutenticacion } from 'src/common/estatus.enum';
import { CodigoPasajeroAutenticacion } from './dto/login-autenticacion.dto';
import { RefreshSessions } from 'src/entities/RefreshSessions';
import { AuthTokensService } from './auth-tokens.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Usuarios)
    private readonly usuariosRepository: Repository<Usuarios>,
    @InjectRepository(UsuariosPermisos)
    private permisosRepository: Repository<UsuariosPermisos>,
    @InjectRepository(CodigoAutenticacion)
    private codigoAutenticacioRepository: Repository<CodigoAutenticacion>,
    @InjectRepository(RefreshSessions)
    private readonly refreshSessionsRepository: Repository<RefreshSessions>,
    private readonly jwtService: JwtService,
    private readonly emailService: MailService,
    private readonly bitacoraLogger: BitacoraLoggerService,
    private readonly authTokensService: AuthTokensService,
    private readonly dataSource: DataSource,
  ) { }

  // ========================================
  //login por correo
  // ========================================
  async signIn(loginAuthDto: LoginAuthDto) {
    try {
      const user = await this.usuariosRepository.findOne({
        relations: ['cliente2'],
        where: {
          userName: loginAuthDto.userName,
          estatus: 1,
          emailConfirmado: 1,
          cliente2: {
            estatus: 1,
          },
        },
      });

      // Mismo 401 para no enumerar usuarios
      if (
        !user ||
        !user.passwordHash ||
        !(await bcrypt.compare(loginAuthDto.password, user.passwordHash))
      ) {
        throw new UnauthorizedException('Credenciales inválidas');
      }

      await this.usuariosRepository.update(user.id, {
        ultimoLogin: new Date().toISOString(),
      });

      const token = this.authTokensService.signAccessToken(user);
      const {
        token: refreshToken,
        jti,
        expiresAt,
      } = this.authTokensService.signRefreshToken(Number(user.id));

      await this.refreshSessionsRepository.save(
        this.refreshSessionsRepository.create({
          idUsuario: Number(user.id),
          jti,
          tokenHash: this.authTokensService.hashRefreshToken(refreshToken),
          expiresAt,
          revokedAt: null,
          replacedById: null,
        }),
      );

      return {
        token,
        refreshToken,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(error);
    }
  }

  // ========================================
  // Perfil del usuario autenticado (/me)
  // ========================================
  async getMe(userId: number) {
    const user = await this.usuariosRepository.findOne({
      relations: ['idRol2', 'cliente2'],
      where: {
        id: Number(userId),
        estatus: 1,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no autorizado');
    }

    const permisos = await this.permisosRepository.find({
      select: ['idPermiso'],
      where: {
        idUsuario: Number(user.id),
        estatus: 1,
      },
    });

    // Misma forma de datos que el login anterior (sin token/refreshToken)
    return {
      message: 'Perfil obtenido exitosamente',
      id: Number(`${user.id}`),
      nombre: `${user.nombre ?? ''}`,
      apellidoPaterno: `${user.apellidoPaterno ?? ''}`,
      apellidoMaterno: `${user.apellidoMaterno ?? ''}`,
      idCliente: Number(`${user.idCliente}`),
      nombreCliente: `${user.cliente2?.nombre ?? ''}`,
      apellidoPaternoCliente: `${user.cliente2?.apellidoPaterno ?? ''}`,
      apellidoMaternoCliente: `${user.cliente2?.apellidoMaterno ?? ''}`,
      logotipo: `${user.cliente2?.logotipo ?? ''}`,
      telefono: `${user.telefono ?? ''}`,
      ultimoLogin: `${user.ultimoLogin ?? ''}`,
      fechaCreacion: `${user.fechaCreacion ?? ''}`,
      fotoPerfil: `${user.fotoPerfil ?? ''}`,
      userName: `${user.userName ?? ''}`,
      rol: user.idRol2,
      permisos,
    };
  }

  // ========================================
  // Refresh token (rotación obligatoria)
  // ========================================
  async refreshTokens(dto: RefreshTokenDto) {
    let payload: { id?: number; type?: string; jti?: string };

    try {
      payload = this.jwtService.verify(dto.refreshToken, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    if (
      payload?.type !== 'refresh' ||
      !payload?.jti ||
      payload?.id === undefined ||
      payload?.id === null
    ) {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    const session = await this.refreshSessionsRepository.findOne({
      where: {
        jti: payload.jti,
        idUsuario: Number(payload.id),
      },
    });

    const tokenHash = this.authTokensService.hashRefreshToken(dto.refreshToken);
    const now = new Date();

    if (
      !session ||
      session.revokedAt != null ||
      session.tokenHash !== tokenHash ||
      new Date(session.expiresAt).getTime() <= now.getTime()
    ) {
      throw new UnauthorizedException(
        'Sesión de refresh inválida o revocada',
      );
    }

    const user = await this.usuariosRepository.findOne({
      where: { id: Number(payload.id), estatus: 1 },
    });
    if (!user) {
      throw new UnauthorizedException(
        'Sesión de refresh inválida o revocada',
      );
    }

    const accessToken = this.authTokensService.signAccessToken(user);
    const {
      token: newRefreshToken,
      jti: newJti,
      expiresAt: newExpiresAt,
    } = this.authTokensService.signRefreshToken(Number(user.id));

    await this.dataSource.transaction(async (manager) => {
      const newSession = await manager.save(
        RefreshSessions,
        manager.create(RefreshSessions, {
          idUsuario: Number(user.id),
          jti: newJti,
          tokenHash: this.authTokensService.hashRefreshToken(newRefreshToken),
          expiresAt: newExpiresAt,
          revokedAt: null,
          replacedById: null,
        }),
      );

      await manager.update(RefreshSessions, session.id, {
        revokedAt: now,
        replacedById: Number(newSession.id),
      });
    });

    return {
      token: accessToken,
      refreshToken: newRefreshToken,
    };
  }

  // ========================================
  // Logout (idempotente)
  // ========================================
  async logoutRefresh(dto: RefreshTokenDto) {
    try {
      const payload = this.jwtService.verify(dto.refreshToken, {
        secret: process.env.JWT_SECRET,
      }) as { id?: number; type?: string; jti?: string };

      if (
        payload?.type === 'refresh' &&
        payload?.jti &&
        payload?.id !== undefined &&
        payload?.id !== null
      ) {
        const session = await this.refreshSessionsRepository.findOne({
          where: {
            jti: payload.jti,
            idUsuario: Number(payload.id),
          },
        });

        const tokenHash = this.authTokensService.hashRefreshToken(
          dto.refreshToken,
        );

        if (
          session &&
          session.revokedAt == null &&
          session.tokenHash === tokenHash
        ) {
          await this.refreshSessionsRepository.update(session.id, {
            revokedAt: new Date(),
          });
        }
      }
    } catch {
      // Idempotente: no revelar si el token existía o era inválido
    }

    return { message: 'Sesión cerrada' };
  }

  // ========================================
  // Revocación masiva de sesiones activas
  // ========================================
  async revokeAllRefreshSessionsForUser(userId: number): Promise<void> {
    await this.refreshSessionsRepository.update(
      {
        idUsuario: Number(userId),
        revokedAt: IsNull(),
      },
      { revokedAt: new Date() },
    );
  }

  // ========================================
  //confirmacion de correo
  // ========================================
  async verifyUser(codigoPasajeroAutenticacion: CodigoPasajeroAutenticacion) {
    try {
      //Buscamos el codigo en la tabla CodigoAutenticacion tiene que ser  Tipo: 0 y Estatus: 1
      const codigoValido = await this.codigoAutenticacioRepository.findOne({
        where: {
          codigo: codigoPasajeroAutenticacion.codigo,
          tipo: TipoCodigoAutenticacion.CONFIRMACION_CORREO,
          usado: EstatusEnum.ACTIVO,
        },
      });

      //En caso de no encontrar manda error
      if (!codigoValido) {
        throw new BadRequestException('Código inválido o ya usado');
      }

      //Buscamos al usuario por la relacion que tiene la tabla CodigoAutenticacion
      const user = await this.usuariosRepository.findOne({
        where: { id: codigoValido.idUsuario },
      });
      if (!user) throw new BadRequestException('Usuario no encontrado');

      //Generamos la fecha con un retraso de 6 horas para que se guarde de manera correcta
      function pad(n: number) {
        return n < 10 ? '0' + n : n;
      }

      const ahora = new Date();
      const desfaseMs = -6 * 60 * 60 * 1000; // -6 horas en milisegundos
      const fechaDesfasada = new Date(ahora.getTime() + desfaseMs);

      const fechaActual = `${fechaDesfasada.getFullYear()}-${pad(fechaDesfasada.getMonth() + 1)}-${pad(fechaDesfasada.getDate())} ${pad(fechaDesfasada.getHours())}:${pad(fechaDesfasada.getMinutes())}:${pad(fechaDesfasada.getSeconds())}`;

      //Verificamos que la fecha no sea mayor a la de expiracion en caso de ser asi
      //el codigo ha expirado
      if (fechaDesfasada > codigoValido.fechaExpiracion) {
        throw new BadRequestException('El código ha expirado');
      }

      //cambiamos el estatus del email a 1 del usuario correspondiente
      await this.usuariosRepository.update(user.id, { emailConfirmado: 1 });

      //-----Registro en la bitacora----- SUCCESS
      const querylogger = { id: user.id, EmailConfirmado: 1 };
      await this.bitacoraLogger.logToBitacora(
        'Usuarios',
        `Se verifico un usuarios con nombre: ${user.nombre}`,
        'CREATE',
        querylogger,
        Number(user.id),
        2,
        EstatusEnumBitcora.SUCCESS,
      );

      //en la tabla CodigoAutenticacion actualizamos para dar a entender que ya se uso el codigo
      await this.codigoAutenticacioRepository.update(codigoValido.id, {
        usado: EstatusEnum.INACTIVO,
        estatus: EstatusEnum.INACTIVO,
        fechaUso: fechaActual,
      });

      return `La verificación del usuario ${user.nombre} se ha completado con éxito.
Muchas gracias por su preferencia.`;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException({
        message: 'Ocurrió un error al registrar pasajero.',
        error: error.message,
      });
    }
  }

  // ========================================
  //enviar correo para recuperar contraseña
  // ========================================
  async recuperarContrasena(
    loginAuthConfirmacionDto: LoginAuthConfirmacionDto,
  ) {
    try {
      //Buscamos el usuario por correo
      const user = await this.usuariosRepository.findOne({
        where: { userName: loginAuthConfirmacionDto.userName },
      });
      if (!user) throw new BadRequestException('Usuario no encontrado');

      //Generamos el payload para el tokenn
      const payload = {
        id: user.id,
        email: user.userName,
      };

      //Generamos el token
      const token = this.jwtService.sign(payload, {
        expiresIn: `${process.env.JWT_CONFIRMACION}` as any,
      });
      const name = `${user.nombre} ${user.apellidoPaterno} ${user.apellidoMaterno}`;
      await this.emailService.sendResetPasswordEmail(
        user.userName,
        name,
        token,
      );
      return `Se ha enviado un correo para restablecer la contraseña.`;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException({
        message: 'Ocurrió un error al recuperar contraseña del usuario.',
        error: error.message,
      });
    }
  }

  // ========================================
  //Creacion de codigo de autenticacion
  // ========================================
  async generarCodigo(idUsuario: number, tipo: number): Promise<string> {
    // Generar código de 4 dígitos
    const codigo = Math.floor(1000 + Math.random() * 9000).toString();

    //Generamos la fecha de Expiracion
    const ahora = new Date();
    const desfaseMs = -6 * 60 * 60 * 1000; // -6 horas
    const expiracionMs = 15 * 60 * 1000; // +15 minutos

    const expiracion = new Date(ahora.getTime() + expiracionMs + desfaseMs);

    //Buscamos si ya existe un atributo con ese usuario
    const codigoExiste = await this.codigoAutenticacioRepository.findOne({
      where: {
        idUsuario: idUsuario,
      },
    });

    //si existe actualiza los datos
    if (codigoExiste) {
      await this.codigoAutenticacioRepository.update(codigoExiste.id, {
        codigo,
        fechaCreacion: ahora,
        fechaExpiracion: expiracion,
        usado: EstatusEnum.ACTIVO,
        estatus: EstatusEnum.ACTIVO,
        fechaUso: null,
      });
    } else {
      //si no se crea el atributo
      const codigoCreate = this.codigoAutenticacioRepository.create({
        idUsuario: idUsuario,
        codigo: codigo,
        tipo: tipo,
        fechaExpiracion: expiracion,
        usado: EstatusEnum.ACTIVO,
        estatus: EstatusEnum.ACTIVO,
      });
      await this.codigoAutenticacioRepository.save(codigoCreate);
    }

    //regresa el codigo
    return codigo;
  }

  // ========================================
  //actualizar contraseña
  // ========================================
  async resetPassword(loginAuthResetDto: LoginAuthResetDto) {
    try {
      const user = await this.usuariosRepository.findOne({
        where: { userName: loginAuthResetDto.userName },
      });
      if (!user) throw new BadRequestException('Usuario no encontrado');

      const hashedPassword = await bcrypt.hash(loginAuthResetDto.password, 10); //encriptamos la contraseña
      loginAuthResetDto.password = hashedPassword;
      await this.usuariosRepository.update(user.id, {
        passwordHash: hashedPassword,
      });

      await this.revokeAllRefreshSessionsForUser(Number(user.id));

      //-----Registro en la bitacora----- SUCCESS
      const querylogger = { id: user.id, EmailConfirmado: 1 };
      await this.bitacoraLogger.logToBitacora(
        'Usuarios',
        `Se actualizo la contraseña del usuarios con ID: ${user.id}`,
        'CREATE',
        querylogger,
        Number(user.id),
        2,
        EstatusEnumBitcora.SUCCESS,
      );
      return `La contraseña del usuario ${user.nombre} ha sido actualizada exitosamente.`;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException({
        message: 'Ocurrió un error al actualizar contraseña del usuario.',
        error: error.message,
      });
    }
  }
}
