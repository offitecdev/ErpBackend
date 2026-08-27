/* 27.08.2026: den GET /role-templates-Pfad ausserhalb des Servers ausführen —
   genau die Stelle, an der «Rollen konnten nicht geladen werden» entstand.
   Läuft er hier sauber durch, lag es am veralteten Prisma-Client des laufenden
   Servers, nicht am Code. Legt nebenbei die Purser-Rolle je Firmenbaum an. */
import prisma from '../src/infrastructure/database/prisma.client';
import { getCompanyTreeTenantIds } from '../src/presentation/controllers/serviceTenantScope';
import { findTenantRootIdCached } from '../src/shared/tenantTree';
import { ensurePurserRole, ensureSystemAdminRole } from '../src/presentation/routes/roleTemplate.routes';

(async () => {
    // Alle Stämme: Mandanten ohne Elternteil.
    const roots = await prisma.tenant.findMany({
        where: { parentTenantId: null } as any,
        select: { id: true, tenantName: true },
    });
    for (const root of roots) {
        const rootId = (await findTenantRootIdCached(root.id)) ?? root.id;
        const tree = await getCompanyTreeTenantIds(root.id);
        const admin = await ensureSystemAdminRole(rootId, tree);
        const purser = await ensurePurserRole(rootId, tree);
        console.log(`${root.tenantName}: admin=${admin.roleName} purser=${purser.roleName}`);
    }
    const check = await prisma.role.findMany({ where: { isPurser: true } as any, select: { id: true, roleName: true, tenantId: true } });
    console.log('purser roles now:', check.length);
    await prisma.$disconnect();
})().catch((error) => { console.error('FAILED:', error?.message || error); process.exit(1); });
