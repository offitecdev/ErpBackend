import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const p = await prisma.project.findMany({ select: { id: true, projectNumber: true, projectName: true, tenantId: true }, take: 6 });
    console.log('PROJECTS'); p.forEach(r => console.log(' ', r.id, '|', r.projectNumber, '|', r.projectName, '|', r.tenantId));
    const c = await prisma.customer.findMany({ select: { id: true, companyName: true, tenantId: true }, take: 6 });
    console.log('CUSTOMERS'); c.forEach(r => console.log(' ', r.id, '|', r.companyName, '|', r.tenantId));
    const e = await prisma.employee.findMany({ select: { id: true, firstName: true, lastName: true, staffNumber: true, tenantId: true }, take: 6 });
    console.log('EMPLOYEES'); e.forEach(r => console.log(' ', r.id, '|', r.firstName, r.lastName, '| staffNo', r.staffNumber, '|', r.tenantId));
    await prisma.$disconnect();
})();
