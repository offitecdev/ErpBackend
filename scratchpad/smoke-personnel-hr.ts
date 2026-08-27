/**
 * RAUCHPROBE DES PERSONAL-UMBAUS (26.08.2026).
 *
 * Sie mintet einen Zugriffsschlüssel für ein BESTEHENDES Verwaltungskonto (mit
 * dem eigenen Dienst der Anwendung, kein Kennwort im Spiel) und ruft damit die
 * neuen Wege der Reihe nach auf. Zweck ist NUR die Prüfung, ob sie antworten
 * und was sie liefern — geschrieben wird nichts.
 *
 * Aufruf (aus Erp_Backend):
 *   npx ts-node -T -r dotenv/config scratchpad/smoke-personnel-hr.ts
 */
import prisma from '../src/infrastructure/database/prisma.client';
import { JwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api/v1';

const main = async () => {
    /* Bevorzugt ein Konto mit der Administratorrolle: nur damit lassen sich
       auch die rechtegeschützten Wege (Arbeitszeiterfassung, Abwesenheiten)
       abklopfen. Fällt keines an, tut es das erste beste Konto — die
       geschützten Wege antworten dann mit 403, und genau das ist richtig. */
    const select = {
        id: true, tenantId: true, email: true, firstName: true, lastName: true,
        passwordChangedAt: true, staffRole: true,
    } as const;
    const wanted = process.env.SMOKE_EMAIL?.trim().toLowerCase();
    const employee =
        (wanted
            ? await prisma.employee.findFirst({ where: { email: wanted }, select })
            : null)
        ?? await prisma.employee.findFirst({
            where: {
                deletedAt: null,
                isActive: true,
                employeeRoles: { some: { role: { isSystemAdmin: true } } },
            },
            orderBy: { createdAt: 'asc' },
            select,
        })
        ?? await prisma.employee.findFirst({
            where: { deletedAt: null, isActive: true },
            orderBy: { createdAt: 'asc' },
            select,
        });
    if (!employee) throw new Error('Keine Person gefunden.');

    const tokens = new JwtTokenService();
    const token = tokens.generateToken('access', {
        id: employee.id,
        tenantId: employee.tenantId,
        email: employee.email,
        pwdAt: toPwdAtClaim(employee.passwordChangedAt),
    } as any);

    console.log(`Als: ${employee.firstName} ${employee.lastName} <${employee.email}> (${employee.staffRole})`);

    const year = new Date().getFullYear();
    const call = async (path: string) => {
        const response = await fetch(`${BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        let short = text;
        try {
            const parsed = JSON.parse(text);
            short = JSON.stringify(parsed).slice(0, 260);
        } catch { short = text.slice(0, 260); }
        console.log(`${String(response.status).padEnd(4)} ${path}\n     ${short}`);
    };

    await call('/personnel/leave-policy');
    await call(`/personnel/holidays?year=${year}`);
    await call(`/personnel/staff/${employee.id}/profile`);
    await call(`/personnel/staff/${employee.id}/leave-year?year=${year}`);
    await call(`/personnel/staff/${employee.id}/time-log?startDate=${year}-01-01&endDate=${year}-12-31`);
    await call(`/personnel/time-records?startDate=${year}-01-01&endDate=${year}-12-31`);
    await call(`/personnel/absences?startDate=${year}-01-01&endDate=${year}-12-31`);
    await call('/personnel/leaves?scope=incoming');
    await call('/personnel/leaves?scope=mine&requestType=VACATION');
    await call('/personnel/leaves/counts');
};

main()
    .catch((error) => { console.error('FEHLER:', error?.message || error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
