import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../../../infrastructure/database/prisma.client';

export class AuthService {
    async login(email: string, plainPassword: string) {

        const employee = await prisma.employee.findUnique({
            where: { email }
        });

        if (!employee) {
            throw new Error('Kullanıcı bulunamadı.');
        }

        if (!employee.isActive) {
            throw new Error('Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.');
        }

        const isPasswordValid = await bcrypt.compare(plainPassword, employee.passwordHash);
        if (!isPasswordValid) {
            throw new Error('Hatalı parola.');
        }

        const payload = {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email
        };

        const secret = process.env.OFFITEC_JWT_SECRET;
        if (!secret) throw new Error('JWT Secret tanımlanmamış!');

        const token = jwt.sign(payload, secret);

        return {
            token,
            employee: {
                id: employee.id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                tenantId: employee.tenantId
            }
        };
    }
}