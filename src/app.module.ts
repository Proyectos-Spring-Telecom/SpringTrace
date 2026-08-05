import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsuariosModule } from './usuarios/usuarios.module';
import { AuthModule } from './auth/auth.module';
import { BitacoraModule } from './bitacora/bitacora.module';
import { ClientesModule } from './clientes/clientes.module';
import { ModulosModule } from './modulos/modulos.module';
import { PermisosModule } from './permisos/permisos.module';
import { RolesModule } from './roles/roles.module';
import { S3Module } from './s3/s3.module';
import { MailModule } from './mail/mail.module';
import { GatewayModule } from './gateway/gateway.module';
import Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().default(3306),
        DB_USER: Joi.string().required(),
        DB_PASSWORD: Joi.string().allow(''), // Puede estar vacío si no hay pass
        DB_DATABASE: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        JWT_EXPIRES_IN: Joi.string().required(),
        JWT_REFRESH_EXPIRES_IN: Joi.string().required(),
        AWS_REGION: Joi.string().optional(),
        AWS_ACCESS_KEY_ID: Joi.string().optional().allow(''),
        AWS_SECRET_ACCESS_KEY: Joi.string().optional().allow(''),
        AWS_S3_BUCKET: Joi.string().optional().allow(''),
        UPLOAD_MAX_SIZE: Joi.string().optional().allow(''),
        GATEWAY_PORT: Joi.number().optional().default(9001),
        GATEWAY_DEBUG_HEX: Joi.boolean().optional().default(false),
        GATEWAY_CAPTURE_ENABLED: Joi.boolean().optional().default(true),
        GATEWAY_CAPTURE_DIR: Joi.string().optional().default('./capturas'),
        GATEWAY_HISTORICO_ENABLED: Joi.boolean().optional().default(true),
        GATEWAY_HISTORICO_DIR: Joi.string().optional().default('./historico'),
      }),
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql',
        host: config.get<string>('DB_HOST'),
        port: config.get<number>('DB_PORT'),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_DATABASE'),
        autoLoadEntities: false,
        entities: [__dirname + '/entities/*{.ts,.js}'],
        synchronize: false, //Nunca poner en true
        dateStrings: false,
        timezone: config.get<string>('DB_TZ'),
        bigNumberStrings: false,
        logging: true,
        extra: {
          // Evita que bigint se devuelvan como string
          decimalNumbers: true,
        },
      }),
    }),

    UsuariosModule,

    AuthModule,

    BitacoraModule,

    ClientesModule,

    PermisosModule,

    RolesModule,

    S3Module,

    MailModule,

    ModulosModule,

    GatewayModule,
  ],
})
export class AppModule {}
