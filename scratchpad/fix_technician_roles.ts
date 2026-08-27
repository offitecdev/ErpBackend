/**
 * Reparatur: eine Technikerrolle OHNE jedes Recht.
 *
 * Rollen wie «Teknisyen» (x-TzzPOP) tragen weder `pageLevels` noch eine einzige
 * RolePermission-Zeile. Ihre Leute konnten damit NICHTS — im Buero lief jeder
 * Aufruf in ein 403, und auf dem Montagebildschirm ebenso ("Erisim Engellendi:
 * projects.view, projects.report, maintenance.tasks.manage"). Diese Rolle
 * bekommt hier genau das, was ein Haken bei «Montage = Bearbeiten» in
 * /settings/authorization setzt: pageLevels {montage.workspace: 2}, daraus
 * abgeleitet die Rechte projects.view + projects.report und das Modulpaket.
 *
 * Angefasst wird NUR eine Rolle, die (a) nach einem Techniker heisst,
 * (b) keine gespeicherte Stufenkarte hat und (c) kein einziges Recht traegt --
 * eine bewusst gebaute Rolle bleibt unberuehrt.
 */
import prisma from "../src/infrastructure/database/prisma.client";
import {
    moduleKeysForPageLevels,
    permissionsForPageLevels,
    sanitizePageLevels,
} from "../src/shared/pageCatalog";

const TECHNICIAN_NAME = /(teknisyen|techniker|technician)/i;
const APPLY = process.argv.includes("--apply");

(async () => {
    const roles: any[] = await prisma.$queryRawUnsafe(
        `SELECT r.id, r.roleName, r.tenantId, r.pageLevels, r.isSystemAdmin,
                (SELECT COUNT(*) FROM RolePermission rp WHERE rp.roleId = r.id) AS permCount,
                (SELECT COUNT(*) FROM EmployeeRole er WHERE er.roleId = r.id) AS people
           FROM Role r ORDER BY r.roleName`);

    const broken = roles.filter((r) => TECHNICIAN_NAME.test(String(r.roleName))
        && !r.isSystemAdmin
        && r.pageLevels === null
        && Number(r.permCount) === 0);

    if (!broken.length) {
        console.log("Keine leere Technikerrolle gefunden.");
        await prisma.$disconnect();
        return;
    }

    const pageLevels = sanitizePageLevels({ "montage.workspace": 2 });
    const permissionNames = permissionsForPageLevels(pageLevels);
    const moduleKeys = moduleKeysForPageLevels(pageLevels);
    console.log("Stufenkarte:", JSON.stringify(pageLevels));
    console.log("Rechte     :", permissionNames.join(", "));
    console.log("Module     :", moduleKeys.join(", "), "\n");

    for (const role of broken) {
        console.log(`${APPLY ? "REPARIERE" : "WUERDE REPARIEREN"}  ${role.id} "${role.roleName}" (Firma ${role.tenantId}, ${role.people} Person(en))`);
        if (!APPLY) continue;

        const permissions: any[] = await prisma.$queryRawUnsafe(
            `SELECT id, permissionName FROM Permission WHERE permissionName IN (${permissionNames.map(() => "?").join(",")})`,
            ...permissionNames);
        const missing = permissionNames.filter((n) => !permissions.some((p) => p.permissionName === n));
        if (missing.length) throw new Error(`Permission-Zeilen fehlen in der Datenbank: ${missing.join(", ")}`);

        await prisma.role.update({ where: { id: role.id }, data: { pageLevels } as any });
        await prisma.rolePermission.createMany({
            data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
            skipDuplicates: true,
        });

        // Modulpaket je Firma des Baums (getMe zeigt eine Firma nur mit Zeile).
        const tree: any[] = await prisma.$queryRawUnsafe(
            `SELECT id FROM Tenant WHERE id = ? OR parentTenantId = ?
              OR parentTenantId = (SELECT parentTenantId FROM Tenant WHERE id = ?)`,
            role.tenantId, role.tenantId, role.tenantId);
        const tenantIds = [...new Set(tree.map((t) => t.id).filter(Boolean))];
        for (const tenantId of tenantIds) {
            await (prisma as any).roleModuleConfig.upsert({
                where: { roleId_tenantId: { roleId: role.id, tenantId } },
                create: { roleId: role.id, tenantId, moduleKeys },
                update: { moduleKeys },
            });
        }
        console.log(`   ok -- Rechte: ${permissionNames.join(", ")} / Modulzeilen: ${tenantIds.join(", ")}`);
    }

    if (!APPLY) console.log("\nProbelauf. Mit --apply wirklich schreiben.");
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
