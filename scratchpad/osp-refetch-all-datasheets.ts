/* WERKZEUG (21.09.2026): ALLE Datenblätter neu holen.
 *
 * Nach einem Umzug (oder wenn Dateien auf der Platte eines Rechners liegen
 * geblieben sind, den es nicht mehr gibt) holt dies jedes Blatt neu — Projekt
 * für Projekt, über dieselbe Adresse, die auch der Knopf „Dokumente holen"
 * benutzt. Danach liegen sie in R2 und sind von jedem Rechner zu öffnen.
 *
 * Blätter, die die OSP inzwischen ersetzt und drüben gelöscht hat, bleiben
 * fehlend: dagegen hilft nur eine neue Adresse von drüben.
 *
 * Aufruf: npx ts-node --transpile-only scratchpad/osp-refetch-all-datasheets.ts
 */
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
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const docs = await (prisma as any).ospDocument.findMany({ select: { id: true, reference: true } });
    for (const doc of docs) {
        const res = await fetch(`http://localhost:3000/api/v1/osp/documents/${doc.id}/datasheets`, {
            method: 'POST', headers: auth, body: JSON.stringify({ force: true }),
        });
        const body: any = await res.json();
        console.log(`${doc.reference}: geholt=${body.fetched} fehler=${body.failed}`);
    }
    const units = await (prisma as any).ospUnit.findMany({
        where: { datasheetSpecs: { not: null } },
        select: { ospDocumentId: true, unitModel: true, datasheetSpecs: true },
    });
    console.log('');
    for (const u of units) {
        const s = u.datasheetSpecs || {};
        console.log(` ${u.ospDocumentId} ${(u.unitModel || '—').padEnd(20)} cop=${s.cop ?? '—'} eer=${s.eer ?? '—'} medium=${s.medium ?? '—'} preis=${s.listPrice ?? '—'}`);
    }
    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
