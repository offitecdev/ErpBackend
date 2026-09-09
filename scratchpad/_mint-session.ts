import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import { writeFileSync } from 'fs';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
(async () => {
    const admin = await prisma.employee.findFirst({
        where: { email: 'admin@offitec.com', deletedAt: null },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!admin) throw new Error('kein admin');
    const access = jwtTokenService.generateToken('access', {
        id: admin.id, tenantId: admin.tenantId, email: admin.email, pwdAt: toPwdAtClaim(admin.passwordChangedAt),
    } as any);
    writeFileSync(process.argv[2], JSON.stringify({ access, tenantId: admin.tenantId }));
    console.log('minted for', admin.email, admin.tenantId);
    await prisma.$disconnect();
})();
