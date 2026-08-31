/* Nur LESEND (31.08.2026): beweist die Personal-Isolation an den ECHTEN
   Helfern und der echten Datenbank.

   Fuer jede Firma: wen zeigt die Personenliste (roher Weg, employeeScopeSql)
   und wen die Prisma-Abfragen (employeeScopeWhere)? Dazu je Konto: welche
   Firmen bietet der Umschalter noch an. */
import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';
import {
    getPersonnelTenantScope,
    getAssignableTenantIds,
    employeeScopeSql,
    employeeScopeWhere,
} from '../src/presentation/controllers/serviceTenantScope';
import { findTenantRootIdCached } from '../src/shared/tenantTree';
import { parseAllowedTenantIds } from '../src/presentation/utils/tenantAccess';

(async () => {
    const tenants = await prisma.tenant.findMany({
        select: { id: true, tenantName: true, parentTenantId: true, isActive: true },
    });
    const nameOf = (id: string) => tenants.find((t) => t.id === id)?.tenantName ?? id;

    console.log('=== Personenliste je Firma ===');
    for (const tenant of tenants) {
        const scope = await getPersonnelTenantScope(tenant.id);

        // Der rohe Weg (Personalliste, Rehber, Berichte).
        const raw = await prisma.$queryRaw<Array<{ id: string; firstName: string; lastName: string; tenantId: string }>>(
            Prisma.sql`SELECT e.id, e.firstName, e.lastName, e.tenantId FROM Employee e
                        WHERE ${employeeScopeSql(scope)} AND e.deletedAt IS NULL
                        ORDER BY e.firstName`,
        );
        // Der Prisma-Weg (Techniker-Auswahl, Mail-Kategorien, Aufgaben).
        const via = await prisma.employee.findMany({
            where: { ...employeeScopeWhere(scope), deletedAt: null },
            select: { id: true, tenantId: true },
        });

        const sameSet = raw.length === via.length
            && raw.every((row) => via.some((other) => other.id === row.id));
        const foreign = raw.filter((row) => row.tenantId !== tenant.id);

        console.log(`\n${tenant.tenantName} (${tenant.id})`);
        console.log(`  Bereich: [${scope.map(nameOf).join(', ') || '—'}]`);
        console.log(`  Personen: ${raw.length}  |  roh == prisma: ${sameSet ? 'ja' : 'NEIN (!)'}`);
        console.log(`  davon aus einer anderen Heimatfirma (nur per Zuteilung): ${foreign.length}`
            + (foreign.length ? ` -> ${foreign.map((f) => `${f.firstName} ${f.lastName} [${nameOf(f.tenantId)}]`).join(', ')}` : ''));
    }

    console.log('\n=== Welche Firmen darf eine Verwaltung zuteilen (Zugang-Flaeche) ===');
    for (const person of await prisma.employee.findMany({
        where: { deletedAt: null },
        select: { id: true, firstName: true, lastName: true, tenantId: true, allowedTenantIds: true },
    })) {
        const picked = parseAllowedTenantIds(person.allowedTenantIds);
        const selected = picked && picked[0] ? picked[0] : person.tenantId;
        const assignable = await getAssignableTenantIds(selected, person.tenantId);
        console.log(`  ${person.firstName} ${person.lastName} (gewaehlt: ${nameOf(selected)})`
            + ` -> ${assignable.map(nameOf).join(', ')}`);
    }

    console.log('\n=== Firmenumschalter je Konto ===');
    const employees = await prisma.employee.findMany({
        where: { deletedAt: null },
        select: { id: true, firstName: true, lastName: true, tenantId: true, allowedTenantIds: true },
        orderBy: [{ tenantId: 'asc' }, { firstName: 'asc' }],
    });
    for (const employee of employees) {
        const assigned = parseAllowedTenantIds(employee.allowedTenantIds);
        const homeRootId = await findTenantRootIdCached(employee.tenantId);
        const inTree: string[] = [];
        for (const tenantId of assigned ?? []) {
            if ((await findTenantRootIdCached(tenantId)) === homeRootId) inTree.push(tenantId);
        }
        const selectable = inTree.length ? inTree : [employee.tenantId];
        console.log(`${employee.firstName} ${employee.lastName} [${nameOf(employee.tenantId)}]`
            + ` -> ${selectable.map(nameOf).join(', ')}`);
    }

    // Die Kontrollfrage: sieht sich jedes Konto in mindestens einer waehlbaren
    // Firma selbst? Sonst kaeme es nie wieder an die eigene Zuteilung heran.
    console.log('\n=== Aussperrungspruefung ===');
    let stranded = 0;
    for (const employee of employees) {
        const assigned = parseAllowedTenantIds(employee.allowedTenantIds);
        const homeRootId = await findTenantRootIdCached(employee.tenantId);
        const inTree = [];
        for (const tenantId of assigned ?? []) {
            if ((await findTenantRootIdCached(tenantId)) === homeRootId) inTree.push(tenantId);
        }
        const selectable = inTree.length ? inTree : [employee.tenantId];
        let visibleSomewhere = false;
        for (const tenantId of selectable) {
            const scope = await getPersonnelTenantScope(tenantId);
            const found = await prisma.employee.findFirst({
                where: { id: employee.id, ...employeeScopeWhere(scope) },
                select: { id: true },
            });
            if (found) { visibleSomewhere = true; break; }
        }
        if (!visibleSomewhere) {
            stranded += 1;
            console.log(`  AUSGESPERRT: ${employee.firstName} ${employee.lastName} <${employee.id}>`);
        }
    }
    console.log(stranded === 0 ? '  Kein Konto ist ausgesperrt.' : `  ${stranded} Konto/Konten ausgesperrt!`);

    await prisma.$disconnect();
})().catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
});
