import prisma from '../../../infrastructure/database/prisma.client';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';

export class EmployeeService {
    
    async createEmployee(data: any) {
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(data.password, saltRounds);

        return await prisma.employee.create({
            data: {
                id: nanoid(8),
                tenantId: data.tenantId,
                firstName: data.firstName,
                lastName: data.lastName,
                email: data.email,
                passwordHash: hashedPassword, 
                title: data.title,
                departmentid: data.departmentid
            } as any
        });
    }

    async verifyEmployeeLogin(email: string, plainPassword: string) {
        const employee = await prisma.employee.findUnique({ where: { email } });
        if (!employee) throw new Error("Kullanıcı bulunamadı.");
        const isPasswordValid = await bcrypt.compare(plainPassword, employee.passwordHash);
        
        if (!isPasswordValid) throw new Error("Hatalı parola.");
        return employee;
    }
}