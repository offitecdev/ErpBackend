import 'dotenv/config';
import prisma from './src/infrastructure/database/prisma.client';

async function main() {
    const tenants = await prisma.tenant.findMany();
    console.log('Tenants:', tenants);
}
main().finally(() => prisma.$disconnect());