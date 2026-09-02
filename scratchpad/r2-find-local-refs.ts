import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * WO STEHEN PLATTENVERWEISE?
 *
 * Der Umzug darf keine Spalte vergessen. Statt sie aufzuzaehlen (und eine zu
 * uebersehen), fragt dieses Skript die Datenbank selbst: jede Textspalte, in
 * der ein Wert mit "local:" beginnt, traegt Dateiverweise und muss beim Umzug
 * mitgeschrieben werden.
 */
(async () => {
    const columns: any[] = await (prisma as any).$queryRawUnsafe(`
        SELECT TABLE_NAME AS t, COLUMN_NAME AS c
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND DATA_TYPE IN ('varchar','text','longtext','mediumtext','json')
        ORDER BY TABLE_NAME, COLUMN_NAME
    `);

    const hits: Array<{ table: string; column: string; rows: number; kinds: string[] }> = [];

    for (const col of columns) {
        const table = String(col.t);
        const column = String(col.c);
        try {
            const [count]: any = await (prisma as any).$queryRawUnsafe(
                `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` LIKE 'local:%'`,
            );
            const rows = Number(count?.n || 0);
            if (rows === 0) continue;

            const samples: any[] = await (prisma as any).$queryRawUnsafe(
                `SELECT DISTINCT SUBSTRING_INDEX(SUBSTRING(\`${column}\`, 7), '/', 1) AS kind
                 FROM \`${table}\` WHERE \`${column}\` LIKE 'local:%' LIMIT 10`,
            );
            hits.push({ table, column, rows, kinds: samples.map((s) => String(s.kind)) });
        } catch {
            /* Spalte nicht vergleichbar — uninteressant. */
        }
    }

    console.log('Zeilen  Ablage                 Spalte');
    console.log('---------------------------------------------------------------');
    let total = 0;
    for (const hit of hits) {
        total += hit.rows;
        console.log(`${String(hit.rows).padStart(6)}  ${hit.kinds.join(', ').padEnd(21)}  ${hit.table}.${hit.column}`);
    }
    console.log('---------------------------------------------------------------');
    console.log(`${String(total).padStart(6)}  Verweise gesamt, in ${hits.length} Spalten`);

    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
