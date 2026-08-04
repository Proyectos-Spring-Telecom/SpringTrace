import { BadRequestException } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';

/**
 * Interceptor Multer para archivos de clientes.
 * Campos: constanciaSituacionFiscal, comprobanteDomicilio, actaConstitutiva, logotipo
 * Documentos: PNG, JPG, JPEG, PDF | Logotipo: PNG, JPG, JPEG
 * Carpeta S3 destino: clientes
 */
export function clientesFileFieldsInterceptor() {
  return FileFieldsInterceptor(
    [
      { name: 'constanciaSituacionFiscal', maxCount: 1 },
      { name: 'comprobanteDomicilio', maxCount: 1 },
      { name: 'actaConstitutiva', maxCount: 1 },
      { name: 'logotipo', maxCount: 1 },
    ],
    {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: Number(process.env.UPLOAD_MAX_SIZE) || 10 * 1024 * 1024,
      },
      fileFilter: (_req, file, cb) => {
        const imageTypes = ['image/png', 'image/jpeg', 'image/jpg'];
        const allowedMimeTypes =
          file.fieldname === 'logotipo'
            ? imageTypes
            : [...imageTypes, 'application/pdf'];

        if (!allowedMimeTypes.includes(file.mimetype)) {
          const msg =
            file.fieldname === 'logotipo'
              ? 'El logotipo solo admite PNG, JPG o JPEG.'
              : 'Solo se permiten archivos PNG, JPG, JPEG o PDF.';
          return cb(new BadRequestException(msg) as unknown as Error, false);
        }
        cb(null, true);
      },
    },
  );
}
