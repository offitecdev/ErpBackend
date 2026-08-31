/* Probelauf der Migration 20260915090000_mail_mailbox_merge_repair: zählt, was
   sie anfassen WÜRDE. Reine SELECTs — es wird nichts geändert. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

const ROOT = `COALESCE(t4.id, t3.id, t2.id, t1.id)`;
const TREE = (alias: string) => `
    JOIN \`Tenant\` t1 ON t1.id = ${alias}.tenantId
    LEFT JOIN \`Tenant\` t2 ON t2.id = t1.parentTenantId
    LEFT JOIN \`Tenant\` t3 ON t3.id = t2.parentTenantId
    LEFT JOIN \`Tenant\` t4 ON t4.id = t3.parentTenantId`;

const n = (value: unknown) => Number(value ?? 0);

(async () => {
    const dupSql = (col: string) => `
        SELECT COUNT(*) AS n FROM (
            SELECT ROW_NUMBER() OVER (
                PARTITION BY r.root, ${col}
                ORDER BY (m.categoryId IS NULL), (m.activityId IS NULL), (m.entityId IS NULL),
                         (m.customerId IS NULL), (m.employeeId IS NULL), (m.deletedAt IS NOT NULL),
                         m.createdAt, m.id) AS rn
              FROM \`MailMessage\` m
              JOIN (SELECT m2.id AS id, ${ROOT} AS root FROM \`MailMessage\` m2 ${TREE('m2')}) r ON r.id = m.id
             WHERE ${col.split(',')[0]} IS NOT NULL
        ) x WHERE x.rn > 1`;

    const [byProvider] = await prisma.$queryRawUnsafe<any[]>(dupSql('m.providerMessageId'));
    const [byMessageId] = await prisma.$queryRawUnsafe<any[]>(dupSql('m.internetMessageId, m.direction'));

    const moving = await prisma.$queryRawUnsafe<any[]>(`
        SELECT m.tenantId AS von, ${ROOT} AS nach, COUNT(*) AS n
          FROM \`MailMessage\` m ${TREE('m')}
         WHERE m.tenantId <> ${ROOT}
         GROUP BY m.tenantId, ${ROOT}`);

    const cats = await prisma.$queryRawUnsafe<any[]>(`
        SELECT c.tenantId AS von, ${ROOT} AS nach, COUNT(*) AS n
          FROM \`MailCategory\` c ${TREE('c')}
         WHERE c.tenantId <> ${ROOT}
         GROUP BY c.tenantId, ${ROOT}`);

    const catDupes = await prisma.$queryRawUnsafe<any[]>(`
        SELECT COUNT(*) AS n FROM (
            SELECT c.id, MIN(c.id) OVER (PARTITION BY r.root, c.kind, COALESCE(c.entityId,'')) AS keepId
              FROM \`MailCategory\` c
              JOIN (SELECT c2.id AS id, ${ROOT} AS root FROM \`MailCategory\` c2 ${TREE('c2')}) r ON r.id = c.id
        ) x WHERE x.id <> x.keepId`);

    const settings = await prisma.$queryRawUnsafe<any[]>(`
        SELECT s.tenantId, s.imapCaptureEnabled, ${ROOT} AS root
          FROM \`MailSetting\` s ${TREE('s')}`);

    console.log('=== Nachrichten: Doppelte, die WEGFALLEN ===');
    console.log('  gleiche Server-Nachricht (Ordner:UID):', n(byProvider?.n));
    console.log('  gleiche Message-ID + Richtung:        ', n(byMessageId?.n));
    console.log('=== Nachrichten: UMHÄNGEN an den Stamm ===');
    moving.forEach((r) => console.log(`  ${r.von} → ${r.nach}: ${n(r.n)}`));
    if (!moving.length) console.log('  (nichts)');
    console.log('=== Kategorien ===');
    console.log('  zusammengelegt:', n(catDupes[0]?.n));
    cats.forEach((r) => console.log(`  umgehängt ${r.von} → ${r.nach}: ${n(r.n)}`));
    if (!cats.length) console.log('  (nichts umzuhängen)');
    console.log('=== Einstellungen: Abruf-Schalter ===');
    settings.forEach((r) => console.log(
        `  ${r.tenantId} (Stamm ${r.root}) Abruf=${r.imapCaptureEnabled}`
        + (r.tenantId !== r.root && r.imapCaptureEnabled ? '  → wird AUSGESCHALTET' : '')));

    await prisma.$disconnect();
})();
