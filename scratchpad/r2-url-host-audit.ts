import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * Welche Adressform steht wirklich in den Spalten? (data: / local: / r2: /
 * eine feste Adresse — und wenn ja, welcher Wirt.)
 */

const TARGETS: Array<[string, string]> = [
    ['Document', 'fileUrl'],
    ['CrmTaskDocument', 'fileRef'],
    ['AppointmentDocument', 'fileRef'],
    ['StaffDocument', 'fileRef'],
    ['Position', 'imageUrl'],
    ['Article', 'imageUrl'],
    ['ProjectReportImage', 'imageData'],
    ['Employee', 'profilePictureUrl'],
    ['Tender', 'closingImages'],
    ['PdfImageThumbnail', 'imageUrl'],
];

const bucket = (value: string): string => {
    if (!value) return '(leer)';
    if (value.startsWith('data:')) return 'data:';
    if (value.startsWith('local:')) return 'local:';
    if (value.startsWith('r2:')) return 'r2:';
    if (/^https?:\/\//i.test(value)) {
        try { return new URL(value).host; } catch { return 'https (kaputt)'; }
    }
    if (value.startsWith('[') || value.startsWith('{')) return 'json';
    return `andere (${value.slice(0, 24)})`;
};

(async () => {
    console.log('R2_PUBLIC_URL              :', process.env.R2_PUBLIC_URL || '(leer)');
    console.log('OFFITEC_S3_PUBLIC_BASE_URL :', process.env.OFFITEC_S3_PUBLIC_BASE_URL || '(leer)');
    console.log('');

    for (const [table, column] of TARGETS) {
        let rows: any[];
        try {
            rows = await (prisma as any).$queryRawUnsafe(
                `SELECT LEFT(\`${column}\`, 300) AS v FROM \`${table}\` WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> ''`,
            );
        } catch (error: any) {
            console.log(`${table}.${column}: FEHLER ${error.message.slice(0, 90)}`);
            continue;
        }
        const counts = new Map<string, number>();
        for (const row of rows) {
            const key = bucket(String(row.v));
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        const summary = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([key, n]) => `${key}=${n}`)
            .join('  ');
        console.log(`${table}.${column} (${rows.length}): ${summary || '-'}`);
    }
    process.exit(0);
})().catch((error) => { console.error('FEHLGESCHLAGEN', error); process.exit(1); });
