import { BadRequestException } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';

/**
 * Interceptor Multer para recepción de fotoPerfil en usuarios.
 * - Campo: fotoPerfil (maxCount: 1)
 * - Almacenamiento en memoria (file.buffer)
 * - Solo imágenes PNG/JPG/JPEG
 * - Límite: UPLOAD_MAX_SIZE (fallback 10 MB)
 */
export function usuariosFileFieldsInterceptor() {
  return FileFieldsInterceptor([{ name: 'fotoPerfil', maxCount: 1 }], {
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Number(process.env.UPLOAD_MAX_SIZE) || 10 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
      const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/jpg'];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        return cb(
          new BadRequestException(
            'Solo se permiten imágenes PNG, JPG o JPEG.',
          ) as unknown as Error,
          false,
        );
      }
      cb(null, true);
    },
  });
}
