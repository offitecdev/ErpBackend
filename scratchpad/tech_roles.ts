import prisma from "../src/infrastructure/database/prisma.client";

(async () => {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT e.id AS empId, e.email, e.firstName, e.lastName, e.isActive,
            r.id AS roleId, r.roleName, r.tenantId AS roleTenant, r.pageLevels,
            (SELECT COUNT(*) FROM RolePermission rp WHERE rp.roleId = r.id) AS permCount
       FROM Employee e
       JOIN EmployeeRole er ON er.employeeId = e.id
       JOIN Role r ON r.id = er.roleId
      ORDER BY r.roleName, e.email`);
  for (const r of rows) {
    console.log(`${String(r.roleName).padEnd(18)} role=${String(r.roleId).padEnd(22)} perms=${r.permCount} pageLevels=${r.pageLevels === null ? 'NULL' : 'set'}  <- ${r.email} (${r.firstName} ${r.lastName}) active=${r.isActive}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
