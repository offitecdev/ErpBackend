import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * Einmalige Notreparatur (14.08.2026): Die Berechtigungsseite hat beim
 * Speichern des eigenen Kontos die Admin-Rolle durch eine automatisch
 * verwaltete Rolle ohne Verwaltungsrechte ersetzt (Zuweisung ist exklusiv).
 * Dieses Skript hängt das Konto wieder an die kanonische Admin-Rolle
 * ('admin-role' aus dem Seed — sie trägt den vollen Rechtekatalog).
 *
 * Aufruf: npx ts-node prisma/restoreAdmin.ts <email>
 */

const email = process.argv[2] || 'sametoffitec2026@gmail.com';

(async () => {
    const employee = await prisma.employee.findUnique({
        where: { email },
        select: { id: true, firstName: true, lastName: true, roleName: true },
    });
    if (!employee) {
        console.error(`Kein Konto mit E-Mail ${email} gefunden.`);
        process.exit(1);
    }

    const adminRole = await prisma.role.findUnique({
        where: { id: 'admin-role' },
        select: { id: true, roleName: true, permissions: { select: { permissionId: true } } },
    });
    if (!adminRole) {
        console.error("Die kanonische Admin-Rolle 'admin-role' existiert nicht — bitte melden.");
        process.exit(1);
    }

    const before = await prisma.employeeRole.findMany({
        where: { employeeId: employee.id },
        select: { roleId: true, role: { select: { roleName: true } } },
    });
    console.log(`Konto: ${employee.firstName} ${employee.lastName} <${email}>`);
    console.log('Bisherige Zuweisung:', before.map((entry) => `${entry.role.roleName} (${entry.roleId})`).join(', ') || '—');

    // Exklusive Zuweisung wie im Haus üblich: alte Zeilen weg, Admin-Rolle rein.
    await prisma.$transaction([
        prisma.employeeRole.deleteMany({ where: { employeeId: employee.id } }),
        prisma.employeeRole.create({ data: { employeeId: employee.id, roleId: adminRole.id } }),
        prisma.employee.update({ where: { id: employee.id }, data: { roleName: adminRole.roleName } }),
    ]);

    console.log(`Wiederhergestellt: ${adminRole.roleName} (${adminRole.permissions.length} Rechte).`);
    console.log('Der Rechte-Zwischenspeicher läuft binnen 60 s aus — danach einmal neu laden oder ab- und anmelden.');
    process.exit(0);
})().catch((error) => {
    console.error('Wiederherstellung fehlgeschlagen:', error?.message || error);
    process.exit(1);
});
