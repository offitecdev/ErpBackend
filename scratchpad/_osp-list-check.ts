import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({ select: { tenantId: true, tenantIds: true } });
    const participating: string[] = [setting.tenantId, ...(Array.isArray(setting.tenantIds) ? setting.tenantIds.map(String) : [])];
    const actor = await prisma.employee.findFirst({
        where: { tenantId: { in: participating } },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    const token = jwtTokenService.generateToken('access', {
        id: actor!.id, tenantId: actor!.tenantId, email: actor!.email, pwdAt: toPwdAtClaim(actor!.passwordChangedAt),
    } as any);
    const res = await fetch('http://localhost:3000/api/v1/osp/documents?page=1&pageSize=15', {
        headers: { Authorization: `Bearer ${token}` },
    });
    const body: any = await res.json();
    console.log('status', res.status, '| total', body.total, '| counts', JSON.stringify(body.counts));
    for (const doc of body.items || []) {
        console.log(` ${doc.reference} "${doc.projectName}" status=${doc.status} units=${(doc.units || []).length}`,
            (doc.units || []).map((u: any) => `${u.ospDocumentId}:${u.unitModel || '—'}${u.datasheetFile ? '+pdf' : ''}`).join(' '));
    }
    const leftovers = await (prisma as any).ospDocument.count({ where: { projectNumber: { in: ['9000001', '9000002'] } } });
    console.log('Wegwerf-Reste:', leftovers, '| Strom-Reste:', await (prisma as any).ospFeedEntry.count());
    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
