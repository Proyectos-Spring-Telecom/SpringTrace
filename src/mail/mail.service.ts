// src/email/email.service.ts

import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
    private transporter: nodemailer.Transporter;

    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.HOST, // o tu proveedor SMTP
            port: process.env.SMTP,
            secure: true,
            auth: {
                user: process.env.E_MAIL,
                pass: process.env.E_MAIL_PASS,
            },
        });
    }

    async sendResetPasswordEmail(to: string, name: string, token: string) {
        try {
            const url = `ruta-${token}`;
            // 👆 Este debe apuntar a tu frontend Angular (puedes ajustarlo a localhost:3000 si haces la prueba desde backend)

            await this.transporter.sendMail({
                from: ` <${process.env.E_MAIL}>`,
                to,
                subject: 'Restablecimiento de contraseña',
                html: `
<h1>Restablecimiento de contraseña</h1>
<p>Hola ${name},</p>
<p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el siguiente enlace para continuar:</p>
<a href="${url}">Restablecer contraseña</a>
<p>Si no solicitaste este restablecimiento, por favor ignora este correo.</p>
<p>Saludos,</p>
<p>Equipo de soporte</p>
      `,
            });
        } catch (error) {
            console.error(
                'Error al enviar correo de restablecimiento de contraseña:',
                error.message,
            );
            throw error;
        }
    }
}
