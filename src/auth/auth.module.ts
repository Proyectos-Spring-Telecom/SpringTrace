import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Usuarios } from 'src/entities/Usuarios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsuariosPermisos } from 'src/entities/UsuariosPermisos';
import { JwtStrategy } from './jwt.strategy';
import { MailModule } from 'src/mail/mail.module';
import { BitacoraModule } from 'src/bitacora/bitacora.module';
import { CodigoAutenticacion } from 'src/entities/CodigoAutenticacion';
import { RefreshSessions } from 'src/entities/RefreshSessions';
import { AuthTokensService } from './auth-tokens.service';

@Module({
  imports: [
    MailModule,
    BitacoraModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get('JWT_EXPIRES_IN') as any,
        },
      }),
    }),
    TypeOrmModule.forFeature([
      Usuarios,
      UsuariosPermisos,
      CodigoAutenticacion,
      RefreshSessions,
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthTokensService, JwtStrategy],
  exports: [JwtModule, AuthService, AuthTokensService],
})
export class AuthModule {}
