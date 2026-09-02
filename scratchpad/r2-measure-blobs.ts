import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * Was liegt wirklich in der Datenbank? (R2-Migration, Bestandsaufnahme)
 *
 * Sucht JEDE grosse Textspalte (LONGTEXT/MEDIUMTEXT/JSON), misst ihr Gewicht
 * und zaehlt, wie viele Zeilen darin eine Daten-URI ("data:...;base64,")
 * tragen. Nur die letzten sind Dateien, die nach R2 gehoeren — ein langer
 * Freitext ist keine Datei.
 */
(async () => {
    const columns: any[] = await (prisma as any).$queryRawUnsafe(`
        SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND DATA_TYPE IN ('longtext','mediumtext','json')
        ORDER BY TABLE_NAME, COLUMN_NAME
    `);

    console.log(`grosse Textspalten: ${columns.length}\n`);

    const rows: Array<{ table: string; column: string; bytes: number; filled: number; dataUris: number }> = [];

    for (const col of columns) {
        const table = String(col.t);
        const column = String(col.c);
        try {
            const [result]: any = await (prisma as any).$queryRawUnsafe(`
                SELECT
                    COALESCE(SUM(LENGTH(\`${column}\`)), 0) AS bytes,
                    SUM(CASE WHEN \`${column}\` IS NOT NULL AND LENGTH(\`${column}\`) > 0 THEN 1 ELSE 0 END) AS filled,
                    SUM(CASE WHEN LOCATE('data:', \`${column}\`) > 0 AND LOCATE(';base64,', \`${column}\`) > 0 THEN 1 ELSE 0 END) AS dataUris
                FROM \`${table}\`
            `);
            const bytes = Number(result?.bytes || 0);
            if (bytes === 0) continue;
            rows.push({
                table,
                column,
                bytes,
                filled: Number(result?.filled || 0),
                dataUris: Number(result?.dataUris || 0),
            });
        } catch (error: any) {
            console.log(`  (uebersprungen ${table}.${column}: ${error.message.split('\n')[0]})`);
        }
    }

    rows.sort((a, b) => b.bytes - a.bytes);

    const mb = (n: number) => (n / 1024 / 1024).toFixed(2).padStart(9);
    let totalAll = 0;
    let totalFiles = 0;

    console.log('MB        Zeilen  davon Daten-URI  Spalte');
    console.log('--------------------------------------------------------------');
    for (const row of rows) {
        totalAll += row.bytes;
        if (row.dataUris > 0) totalFiles += row.bytes;
        const marker = row.dataUris > 0 ? ' <- DATEIEN' : '';
        console.log(`${mb(row.bytes)}  ${String(row.filled).padStart(6)}  ${String(row.dataUris).padStart(15)}  ${row.table}.${row.column}${marker}`);
    }
    console.log('--------------------------------------------------------------');
    console.log(`${mb(totalAll)}  gesamt in grossen Textspalten`);
    console.log(`${mb(totalFiles)}  davon in Spalten, die Daten-URIs tragen (R2-Kandidaten)`);

    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
