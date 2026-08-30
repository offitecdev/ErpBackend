import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const e = await prisma.employee.findMany({ select: { id: true, email: true, firstName: true, lastName: true, tenantId: true, allowedTenantIds: true, isActive: true }, take: 40 });
    e.forEach(r => console.log(r.tenantId, '|', r.email, '|', r.firstName, r.lastName, '| allowed:', JSON.stringify(r.allowedTenantIds), '| active', r.isActive));
    await prisma.$disconnect();
})();
