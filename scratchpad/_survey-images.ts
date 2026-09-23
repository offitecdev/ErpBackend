import prisma from '../src/infrastructure/database/prisma.client';

type Col = [table: string, column: string];
const COLS: Col[] = [
    ['Article', 'imageUrl'],
    ['Position', 'imageUrl'],
    ['PdfImageThumbnail', 'imageUrl'],
    ['Tender', 'closingImages'],
    ['ProjectReportImage', 'imageData'],
    ['ProjectReport', 'customerSignature'],
    ['ProjectReport', 'technicianSignature'],
    ['DeliveryReport', 'customerSignature'],
    ['DeliveryReport', 'technicianSignature'],
    ['DeliveryReport', 'images'],
    ['SignatureRequest', 'signatureBase64'],
    ['MailSetting', 'signatureImage'],
    ['Employee', 'profilePictureUrl'],
    ['Employee', 'profilePictureThumb'],
    ['MaintenanceReport', 'beforePhotoUrls'],
    ['MaintenanceReport', 'afterPhotoUrls'],
    ['MaintenanceReport', 'customerSignature'],
    ['ServiceReport', 'beforePhotoUrls'],
    ['ServiceReport', 'afterPhotoUrls'],
    ['ServiceReport', 'customerSignature'],
    ['CrmTaskNote', 'images'],
];

const mb = (n: number) => `${(Number(n) / 1024 / 1024).toFixed(2)} MB`;

(async () => {
    for (const [table, column] of COLS) {
        try {
            const rows: any[] = await prisma.$queryRawUnsafe(
                `SELECT COUNT(*) AS n,
                        SUM(CASE WHEN \`${column}\` LIKE 'data:%' THEN 1 ELSE 0 END) AS dataUri,
                        SUM(CASE WHEN \`${column}\` LIKE 'r2:%' THEN 1 ELSE 0 END) AS r2ref,
                        SUM(CASE WHEN \`${column}\` LIKE 'local:%' THEN 1 ELSE 0 END) AS localref,
                        SUM(CASE WHEN \`${column}\` LIKE '%r2:%' AND \`${column}\` LIKE '[%' THEN 1 ELSE 0 END) AS jsonR2,
                        SUM(CASE WHEN \`${column}\` LIKE '%data:%' AND \`${column}\` LIKE '[%' THEN 1 ELSE 0 END) AS jsonData,
                        COALESCE(SUM(LENGTH(\`${column}\`)),0) AS bytes
                 FROM \`${table}\` WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> ''`);
            const r = rows[0] || {};
            const n = Number(r.n || 0);
            if (!n) { console.log(`${table}.${column}: empty`); continue; }
            console.log(
                `${table}.${column}: rows=${n} data:=${Number(r.dataUri)} r2:=${Number(r.r2ref)} local:=${Number(r.localref)} json[r2]=${Number(r.jsonR2)} json[data]=${Number(r.jsonData)} size=${mb(r.bytes)}`,
            );
        } catch (e: any) {
            console.log(`${table}.${column}: ! ${String(e.message).split('\n')[0]}`);
        }
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
