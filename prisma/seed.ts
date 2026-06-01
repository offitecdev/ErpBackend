import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';

const DEFAULT_OFFICE_SCHEDULE = {
  workStart: '20:45',
  workEnd: '22:00',
  breaks: [{ label: 'Mola (10 dk)', start: '21:00', end: '21:10' }],
} as const;

const OFFITEC_ROOT_ID = 'offitec-root';
const OFFITEC_SWITZERLAND_ID = 'main-tenant';
const OFFITEC_TURKEY_ID = 'sub-tenant';

async function ensureProjectTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`MailSetting\` (
      \`id\` VARCHAR(191) NOT NULL,
      \`tenantId\` VARCHAR(191) NOT NULL,
      \`fromName\` VARCHAR(191) NULL,
      \`fromEmail\` VARCHAR(191) NULL,
      \`replyTo\` VARCHAR(191) NULL,
      \`smtpHost\` VARCHAR(191) NULL,
      \`smtpPort\` INTEGER NOT NULL DEFAULT 587,
      \`smtpSecure\` BOOLEAN NOT NULL DEFAULT false,
      \`smtpUser\` VARCHAR(191) NULL,
      \`smtpPassword\` TEXT NULL,
      \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE INDEX \`MailSetting_tenantId_key\` (\`tenantId\`),
      INDEX \`MailSetting_tenantId_idx\` (\`tenantId\`),
      CONSTRAINT \`MailSetting_tenantId_fkey\` FOREIGN KEY (\`tenantId\`) REFERENCES \`Tenant\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
    )
  `);
}

async function main() {
  console.log('Seed script başlatılıyor...');

  try {
    await ensureProjectTables();

    const rootTenant = await prisma.tenant.upsert({
      where: { id: OFFITEC_ROOT_ID },
      update: {
        tenantName: 'Offitec',
        parentTenantId: null,
        isActive: true,
        isProjectModuleEnabled: false,
      },
      create: {
        id: OFFITEC_ROOT_ID,
        tenantName: 'Offitec',
        isActive: true,
        isProjectModuleEnabled: false,
      },
    });
    console.log('Ana şirket oluşturuldu:', rootTenant.tenantName);

    const swissTenant = await prisma.tenant.upsert({
      where: { id: OFFITEC_SWITZERLAND_ID },
      update: {
        tenantName: 'Offitec İsviçre',
        parentTenantId: rootTenant.id,
        isActive: true,
        isProjectModuleEnabled: true,
        workScheduleJson: DEFAULT_OFFICE_SCHEDULE as object,
        checkInQrSecret: 'OFFITEC-CH-CHECKIN-DEV',
        checkOutQrSecret: 'OFFITEC-CH-CHECKOUT-DEV',
      },
      create: {
        id: OFFITEC_SWITZERLAND_ID,
        tenantName: 'Offitec İsviçre',
        parentTenantId: rootTenant.id,
        isActive: true,
        isProjectModuleEnabled: true,
        workScheduleJson: DEFAULT_OFFICE_SCHEDULE as object,
        checkInQrSecret: 'OFFITEC-CH-CHECKIN-DEV',
        checkOutQrSecret: 'OFFITEC-CH-CHECKOUT-DEV',
      },
    });
    console.log('İsviçre şirketi oluşturuldu:', swissTenant.id);

    const turkeyTenant = await prisma.tenant.upsert({
      where: { id: OFFITEC_TURKEY_ID },
      update: {
        tenantName: 'Offitec Türkiye',
        parentTenantId: rootTenant.id,
        isActive: true,
        isProjectModuleEnabled: false,
        workScheduleJson: DEFAULT_OFFICE_SCHEDULE as object,
        checkInQrSecret: 'OFFITEC-TR-CHECKIN-DEV',
        checkOutQrSecret: 'OFFITEC-TR-CHECKOUT-DEV',
      },
      create: {
        id: OFFITEC_TURKEY_ID,
        tenantName: 'Offitec Türkiye',
        parentTenantId: rootTenant.id,
        isActive: true,
        isProjectModuleEnabled: false,
        workScheduleJson: DEFAULT_OFFICE_SCHEDULE as object,
        checkInQrSecret: 'OFFITEC-TR-CHECKIN-DEV',
        checkOutQrSecret: 'OFFITEC-TR-CHECKOUT-DEV',
      },
    });
    console.log('Türkiye şirketi oluşturuldu:', turkeyTenant.id);

    const testDepartmentId = 'it-dept';

    const hashedPassword = await bcrypt.hash('Secret123!', 12);
    const admin = await prisma.employee.upsert({
      where: { email: 'admin@offitec.com' },
      update: {
        tenantId: swissTenant.id,
        departmentId: testDepartmentId,
        passwordHash: hashedPassword,
        isActive: true,
      },
      create: {
        id: nanoid(8),
        tenantId: swissTenant.id,
        departmentId: testDepartmentId,
        firstName: 'Admin',
        lastName: 'User',
        email: 'admin@offitec.com',
        passwordHash: hashedPassword,
        title: 'System Administrator',
        isActive: true,
        annualLeaveEntitlement: 20,
      },
    });
    console.log('Admin kullanıcı hazır:', admin.email);

    const permissionNames = [
      'employees.create',
      'employees.view',
      'employees.update',
      'employees.delete',
      'leaves.create',
      'leaves.read',
      'leaves.approve',
      'leaves.delete',
      'attendance.create',
      'attendance.read',
      'attendance.update',
      'roles.manage',
      'users.manage',
      'tenants.create',
      'tenants.update',
      'crm.customers.create',
      'crm.customers.view',
      'crm.customers.addNote',
      'crm.activities.create',
      'crm.documents.upload',
      'tenders.view',
      'tenders.import',
      'tenders.calculate',
      'tenders.manage',
      'tenders.approve',
      'tenders.export',
      'tenders.create',
      'tenders.update',
      'inventory.view',
      'inventory.manage',
      'inventory.transfer',
      'inventory.proposals.manage',
      'inventory.articles.create',
      'inventory.articles.update',
      'inventory.articles.delete',
      'projects.view',
      'projects.create',
      'projects.manage',
      'projects.approve',
      'projects.report',
      'projects.approveVariation',
      'projects.bookings.manage',
      'projects.mail',
      'mail.manage',
      'mail.send',
      'logistics.view',
      'logistics.manage',
    ];

    const permissions = await Promise.all(
      permissionNames.map((name) =>
        prisma.permission.upsert({
          where: { permissionName: name },
          update: {},
          create: { id: nanoid(8), permissionName: name },
        })
      )
    );
    console.log('Permissions hazır:', permissionNames.length);

    const adminRole = await prisma.role.upsert({
      where: { id: 'admin-role' },
      update: {
        tenantId: swissTenant.id,
        roleName: 'Admin',
      },
      create: {
        id: 'admin-role',
        tenantId: swissTenant.id,
        roleName: 'Admin',
      },
    });
    console.log('Admin rolü hazır:', adminRole.roleName);

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
      });
    }
    console.log('Tüm permissions Admin rolüne atandı.');

    await prisma.employeeRole.upsert({
      where: {
        employeeId_roleId: {
          employeeId: admin.id,
          roleId: adminRole.id,
        },
      },
      update: {},
      create: {
        employeeId: admin.id,
        roleId: adminRole.id,
      },
    });
    console.log('Admin rolü kullanıcıya atandı.');

    const leaveTypeNames = [
      { id: 'lt-yillik', typeName: 'Yıllık İzin' },
      { id: 'lt-ucretsiz', typeName: 'Ücretsiz İzin' },
      { id: 'lt-rapor', typeName: 'Rapor (Sağlık)' },
      { id: 'lt-bayram', typeName: 'Bayram Tatili' },
      { id: 'lt-resmi', typeName: 'Resmi Tatil' },
      { id: 'lt-diger', typeName: 'Diğer' },
    ];

    for (const lt of leaveTypeNames) {
      await prisma.leaveType.upsert({
        where: { id: lt.id },
        update: {
          tenantId: swissTenant.id,
          typeName: lt.typeName,
        },
        create: {
          id: lt.id,
          tenantId: swissTenant.id,
          typeName: lt.typeName,
        },
      });
    }
    console.log('İzin türleri hazır:', leaveTypeNames.length);

    const projectMaterials = [
      { id: 'mat-panel-60x60', serialId: 'MAT-CH-001', name: 'Tavan Paneli 60x60', stockQuantity: 120, unitCost: 18.5 },
      { id: 'mat-led-driver', serialId: 'MAT-CH-002', name: 'LED Sürücü 24V', stockQuantity: 80, unitCost: 32 },
      { id: 'mat-cable-3x15', serialId: 'MAT-CH-003', name: 'Kablo 3x1.5', stockQuantity: 500, unitCost: 1.8 },
      { id: 'mat-mount-set', serialId: 'MAT-CH-004', name: 'Montaj Bağlantı Seti', stockQuantity: 200, unitCost: 7.25 },
    ];

    for (const material of projectMaterials) {
      await prisma.material.upsert({
        where: { serialId: material.serialId },
        update: {
          tenantId: swissTenant.id,
          name: material.name,
          stockQuantity: material.stockQuantity,
          unitCost: material.unitCost,
          isActive: true,
        },
        create: {
          ...material,
          tenantId: swissTenant.id,
          isActive: true,
        },
      });
    }
    console.log('Proje malzemeleri hazır:', projectMaterials.length);

    const warehouse = await prisma.location.upsert({
      where: { id: 'loc-ch-main' },
      update: {
        tenantId: swissTenant.id,
        locationName: 'Offitec İsviçre Ana Depo',
        locationType: 'MAIN_WAREHOUSE',
        isActive: true,
      },
      create: {
        id: 'loc-ch-main',
        tenantId: swissTenant.id,
        locationName: 'Offitec İsviçre Ana Depo',
        locationType: 'MAIN_WAREHOUSE',
        isActive: true,
      },
    });

    const inventoryArticles = [
      { id: 'art-panel-60x60', articleCode: 'ART-CH-001', name: 'Tavan Paneli 60x60', unit: 'adet', baseCost: 18.5, quantity: 120, category: 'Montaj' },
      { id: 'art-led-driver', articleCode: 'ART-CH-002', name: 'LED Sürücü 24V', unit: 'adet', baseCost: 32, quantity: 80, category: 'Elektrik' },
      { id: 'art-cable-3x15', articleCode: 'ART-CH-003', name: 'Kablo 3x1.5', unit: 'metre', baseCost: 1.8, quantity: 500, category: 'Elektrik' },
      { id: 'art-mount-set', articleCode: 'ART-CH-004', name: 'Montaj Bağlantı Seti', unit: 'set', baseCost: 7.25, quantity: 200, category: 'Montaj' },
    ];

    for (const article of inventoryArticles) {
      const savedArticle = await prisma.article.upsert({
        where: { tenantId_articleCode: { tenantId: swissTenant.id, articleCode: article.articleCode } },
        update: {
          name: article.name,
          unit: article.unit,
          baseCost: article.baseCost,
          category: article.category,
          isActive: true,
          status: 'ACTIVE',
          minStockLevel: 10,
          criticalStockLevel: 5,
        },
        create: {
          id: article.id,
          tenantId: swissTenant.id,
          articleCode: article.articleCode,
          name: article.name,
          unit: article.unit,
          baseCost: article.baseCost,
          category: article.category,
          isActive: true,
          status: 'ACTIVE',
          minStockLevel: 10,
          criticalStockLevel: 5,
        },
      });

      await prisma.stockBalance.upsert({
        where: { articleId_locationId: { articleId: savedArticle.id, locationId: warehouse.id } },
        update: {
          tenantId: swissTenant.id,
          currentQuantity: article.quantity,
          reservedQuantity: 0,
        },
        create: {
          id: `bal-${article.id}`,
          tenantId: swissTenant.id,
          articleId: savedArticle.id,
          locationId: warehouse.id,
          currentQuantity: article.quantity,
          reservedQuantity: 0,
        },
      });
    }
    console.log('Stok malzemeleri hazır:', inventoryArticles.length);

    console.log('\n======================================================');
    console.log('Seed işlemi başarıyla tamamlandı!');
    console.log(`Tenant ID (Kök): ${rootTenant.id}`);
    console.log(`Tenant ID (Offitec İsviçre - mevcut veriler): ${swissTenant.id}`);
    console.log(`Tenant ID (Offitec Türkiye - proje modülü kapalı): ${turkeyTenant.id}`);
    console.log(`Department ID: ${testDepartmentId}`);
    console.log('======================================================\n');
  } catch (error) {
    console.error('Seed sırasında hata:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
