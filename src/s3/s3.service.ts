import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  HttpException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import { BitacoraLoggerService } from 'src/bitacora/bitacora.service';
import { EstatusEnumBitcora } from 'src/common/ApiResponse';

@Injectable()
export class S3Service {
  private client: S3Client;
  private bucket: string;

  constructor(private readonly bitacoraLogger: BitacoraLoggerService) {
    this.client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    this.bucket = process.env.AWS_S3_BUCKET!;
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string,
    idUser: number,
    idModule: number,
  ) {
    try {
      if (!file) throw new BadRequestException('Archivo requerido');

      // Validar tipo de archivo
      const allowedMimeTypes = [
        'image/png',
        'image/jpg',
        'image/jpeg',
        'application/pdf',
      ];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new BadRequestException('Solo se permiten PNG, JPG, JPEG o PDF');
      }

      if (file.size >= Number(process.env.UPLOAD_MAX_SIZE)) {
        throw new BadRequestException('Archivo demasiado grande');
      }

      // Definir extensión
      let extension = '';
      if (file.mimetype === 'image/png') extension = 'png';
      else if (file.mimetype === 'image/jpg') extension = 'jpg';
      else if (file.mimetype === 'image/jpeg') extension = 'jpeg';
      else if (file.mimetype === 'application/pdf') extension = 'pdf';

      const key = `${folder}/${uuid()}.${extension}`;

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          ACL: 'private', // sigue siendo privado
        }),
      );

      const publicUrl = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      //-----Registro en la bitacora----- SUCCESS
      const querylogger = { data: `INSERT INTO ${folder} (...) VALUES (...) -> bucket:  ${this.bucket} url: ${publicUrl}` };
      await this.bitacoraLogger.logToBitacora(
        `${folder}`,
        `Se subio archivo al bucket: ${this.bucket}`,
        'CREATE',
        querylogger,
        idUser,
        idModule,
        EstatusEnumBitcora.SUCCESS,
      );

      return { url: publicUrl };
    } catch (error) {
      //-----Registro en la bitacora----- ERROR
      const querylogger = { data: `INSERT INTO ${folder} (...) VALUES (...) -> bucket:  ${this.bucket}` };
      await this.bitacoraLogger.logToBitacora(
        `${folder}`,
        `Se subio archivo al bucket: ${this.bucket}`,
        'CREATE',
        querylogger,
        idUser,
        idModule,
        EstatusEnumBitcora.ERROR,
        error.message,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException('Error subiendo el archivo a S3');
    }
  }

  async getPresignedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  /**
   * Extrae la key del objeto a partir de la URL pública generada por uploadFile.
   * Ejemplo: https://bucket.s3.region.amazonaws.com/usuarios/uuid.png → usuarios/uuid.png
   */
  private extractKeyFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      const key = parsed.pathname.startsWith('/')
        ? parsed.pathname.slice(1)
        : parsed.pathname;
      return key || null;
    } catch {
      return null;
    }
  }

  /**
   * Elimina un objeto del bucket. Fallos no bloquean el flujo principal.
   */
  async deleteFile(url: string): Promise<void> {
    const key = this.extractKeyFromUrl(url);
    if (!key) return;

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch {
      // Silencioso: archivo huérfano posible; no interrumpe la operación
    }
  }

  /**
   * Sube un archivo nuevo y elimina el anterior en segundo plano.
   * Retorna la URL del archivo nuevo.
   */
  async updateFile(
    previousUrl: string | null | undefined,
    file: Express.Multer.File,
    folder: string,
    idUser: number,
    idModule: number,
  ): Promise<{ url: string }> {
    const uploaded = await this.uploadFile(file, folder, idUser, idModule);

    if (previousUrl) {
      // Eliminación en segundo plano (no bloquea la respuesta)
      void this.deleteFile(previousUrl);
    }

    return uploaded;
  }
}
