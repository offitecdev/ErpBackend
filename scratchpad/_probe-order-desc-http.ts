import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';
(async () => {
    const admin = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, tenantId: 'main-tenant' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!admin) throw new Error('kein Konto');
    const token = jwtTokenService.generateToken('access', {
        id: admin.id, tenantId: admin.tenantId, email: admin.email, pwdAt: toPwdAtClaim(admin.passwordChangedAt),
    } as any);
    const r = await fetch(`${BASE}/tenders/Z7x991dw_Q`, { headers: { Authorization: `Bearer ${token}` } });
    const body: any = await r.json();
    console.log('status', r.status, 'tender', body.tender?.tenderNumber, body.tender?.status);
    for (const p of body.positions || []) {
        console.log(p.rowType, '|', String(p.shortDescription).slice(0, 40), '| own=', JSON.stringify(String(p.longDescription || '').slice(0, 20)), '| article=', JSON.stringify(String(p.sourceArticleDescription || '').slice(0, 50)));
    }
    await prisma.$disconnect();
})();
