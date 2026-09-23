/**
 * SERIENNUMMER EINES SCHALTSCHRANKS — `2026-000157` (Vorgabe Baris, 20.09.2026).
 *
 * EIN Schrank, EINE Nummer. Zehn Schränke desselben Modells tragen zehn
 * verschiedene Seriennummern; die Modellnummer bleibt dieselbe
 * (shared/panelModelNumber.ts).
 *
 * ── Woher die Nummer kommt ──────────────────────────────────────────────────
 * Aus derselben Zählertabelle wie AN/PR/AB/NT/RE (`DocumentCounter`), nur mit
 * eigenen Schlüsseln — deshalb braucht das Modul keine eigene Zählertabelle und
 * erbt die Eigenschaften, auf die es hier ankommt:
 *
 *   • `LAST_INSERT_ID`-Upsert ⇒ zwei gleichzeitige Erfassungen bekommen NIE
 *     dieselbe Nummer (der Zähler wird im selben Zug gelesen und erhöht);
 *   • die Zeile bleibt bis zum Ende der Transaktion gesperrt;
 *   • bricht die Transaktion ab, wird auch der Zähler zurückgerollt — es
 *     entsteht keine Lücke und keine verbrannte Nummer.
 *
 * ⚠ Beide Anweisungen müssen auf DERSELBEN Verbindung laufen, darum läuft der
 * Aufruf immer in einem `$transaction`-Block (Prisma bindet ihn an eine
 * Verbindung). Der blanke Client nimmt eine beliebige Verbindung aus dem Pool
 * und zwei Anfragen könnten sich gegenseitig die Nummer lesen.
 *
 * ── Stand 20.09.2026: NUR DIE NUMMERNVERGABE ────────────────────────────────
 * Gebaut ist bewusst nur der Kern — die Nummer selbst. Die Tabelle, in der die
 * vergebenen Schränke stehen (`uretim_pano_seri`), gehört zum Modul und ist
 * noch nicht angelegt; der Zähler kommt deshalb auch ohne sie aus (siehe
 * `highestIssuedSeq`). Sobald es sie gibt, nimmt der Schutz gegen schon
 * vergebene Nummern von selbst seine Arbeit auf.
 *
 * ── FRAGE 3: eine Serie oder eine je Firma? ─────────────────────────────────
 * `PanelSettings.serialScope`: GROUP (Empfehlung — der Hersteller ist EINER,
 * also zählt die Wurzel des Firmenbaums für alle) oder COMPANY (jede Firma
 * zählt selbst). Der Bereich steckt in `serialTenantId` und im Eindeutigkeits-
 * schlüssel von `uretim_pano_seri` — so kollidieren zwei Firmen nie.
 *
 * ── FRAGE 4: Jahreswechsel ──────────────────────────────────────────────────
 * `serialYearlyReset = true` (Empfehlung): der Zähler trägt das Jahr im
 * Schlüssel (`PANEL_SERIAL:2026`) und beginnt am 1. Januar wieder bei 000001 —
 * das Jahr im Code unterscheidet sie. `false`: EIN Schlüssel ohne Jahr, die
 * Reihe läuft über den Jahreswechsel weiter (wie bei den Belegen).
 *
 * ── FRAGE 7: Altschränke ────────────────────────────────────────────────────
 * Nachträglich erfasste Schränke ziehen aus einem EIGENEN Block
 * (`retroBlockStart`, z.B. 900001) über einen eigenen Zählerschlüssel. So
 * mischen sich Nachträge nie in die laufende Produktion, und beide Reihen
 * bleiben lückenlos.
 */
import prisma from '../infrastructure/database/prisma.client';

/** Prisma-Client oder das `tx` einer Transaktion — beide können dasselbe Raw-API. */
type RawClient = {
    $executeRaw: (query: TemplateStringsArray, ...values: any[]) => Promise<number>;
    $queryRaw: (query: TemplateStringsArray, ...values: any[]) => Promise<any>;
    $queryRawUnsafe: (query: string, ...values: any[]) => Promise<any>;
};

export const PANEL_SERIAL_DOC_TYPE = 'PANEL_SERIAL';
export const PANEL_SERIAL_RETRO_DOC_TYPE = 'PANEL_SERIAL_RETRO';

/** Voreinstellungen, falls für die Firma noch keine Zeile gepflegt ist. */
export const PANEL_SERIAL_DEFAULT_DIGITS = 6;

export interface PanelSerialOptions {
    /** Jahr des Codes; Vorgabe = laufendes Jahr. */
    year?: number;
    /** Stellen der laufenden Nummer (2026-000157 = 6). */
    digits?: number;
    /** Zählt jedes Jahr neu (FRAGE 4)? */
    yearlyReset?: boolean;
    /** Nachtrag für einen Altschrank aus dem eigenen Block (FRAGE 7). */
    retro?: boolean;
    /** Beginn des Nachtragsblocks, z.B. 900001. */
    retroBlockStart?: number | null;
}

export interface PanelSerial {
    serialNumber: string;
    year: number;
    seq: number;
    isRetro: boolean;
}

/** `2026` + `157` → «2026-000157». */
export const formatPanelSerial = (year: number, seq: number, digits = PANEL_SERIAL_DEFAULT_DIGITS): string =>
    `${year}-${String(Math.max(1, Math.trunc(seq))).padStart(Math.max(3, Math.trunc(digits) || PANEL_SERIAL_DEFAULT_DIGITS), '0')}`;

/** «2026-000157» → seine Teile; passt die Form nicht, kommt null. */
export const parsePanelSerial = (value: string | null | undefined): { year: number; seq: number } | null => {
    const match = String(value || '').trim().match(/^(\d{4})-(\d+)$/);
    if (!match) return null;
    const year = Number(match[1]);
    const seq = Number(match[2]);
    return Number.isFinite(year) && Number.isFinite(seq) && seq >= 1 ? { year, seq } : null;
};

/** Der Zählerschlüssel dieser Reihe — mit Jahr, wenn jährlich zurückgesetzt wird. */
const counterKey = (year: number, options: PanelSerialOptions): string => {
    const base = options.retro ? PANEL_SERIAL_RETRO_DOC_TYPE : PANEL_SERIAL_DOC_TYPE;
    return options.yearlyReset === false ? base : `${base}:${year}`;
};

/**
 * Die HÖCHSTE laufende Nummer, die im Bereich schon auf einem Schrank steht.
 * Der Zähler darf nie dahinter zurückfallen — auch dann nicht, wenn Zeilen aus
 * einer Übernahme stammen oder der Zähler neu angelegt wurde.
 */
const highestIssuedSeq = async (
    client: RawClient,
    serialTenantId: string,
    year: number,
    floor: number,
    ceiling: number | null,
): Promise<number> => {
    try {
        const rows: any[] = ceiling === null
            ? await client.$queryRaw`
                SELECT MAX(\`serialSeq\`) AS \`maxSeq\` FROM \`uretim_pano_seri\`
                WHERE \`serialTenantId\` = ${serialTenantId} AND \`serialYear\` = ${year}
                  AND \`serialSeq\` >= ${floor}`
            : await client.$queryRaw`
                SELECT MAX(\`serialSeq\`) AS \`maxSeq\` FROM \`uretim_pano_seri\`
                WHERE \`serialTenantId\` = ${serialTenantId} AND \`serialYear\` = ${year}
                  AND \`serialSeq\` BETWEEN ${floor} AND ${ceiling}`;
        const maxSeq = Number(rows?.[0]?.maxSeq ?? 0);
        return Number.isFinite(maxSeq) ? maxSeq : 0;
    } catch (error: any) {
        // Solange die Schranktabelle nicht existiert (gebaut ist vorerst nur der
        // Zählerkern), gibt es nichts, wovor der Zähler zurückweichen müsste:
        // ein fehlendes Objekt ist hier kein Fehler, sondern «noch keine Nummer».
        // 1146 = «Table doesn't exist» (MySQL/MariaDB).
        const text = String(error?.message || '');
        if (/doesn't exist|Unknown table|1146/i.test(text)) return 0;
        throw error;
    }
};

/**
 * Zieht EINE Seriennummer. Muss in einer Transaktion laufen (siehe oben) — der
 * Aufrufer gibt sein `tx` mit, damit ein abgebrochener Vorgang keine Nummer
 * verbrennt.
 */
export const nextPanelSerial = async (
    serialTenantId: string,
    options: PanelSerialOptions = {},
    tx?: any,
): Promise<PanelSerial> => {
    const client: RawClient = (tx as RawClient) || (prisma as unknown as RawClient);
    const year = Math.trunc(options.year || new Date().getFullYear());
    const digits = options.digits ?? PANEL_SERIAL_DEFAULT_DIGITS;
    const retro = Boolean(options.retro);

    // Der Nachtragsblock beginnt bei `retroBlockStart`; die laufende Reihe bei 1.
    const blockStart = retro ? Math.max(1, Math.trunc(options.retroBlockStart || 0)) : 1;
    if (retro && !options.retroBlockStart) {
        throw Object.assign(
            new Error('Für Altschränke ist kein eigener Nummernblock eingestellt (Einstellungen → Panolar).'),
            { status: 409, code: 'RETRO_BLOCK_MISSING' },
        );
    }
    // Die laufende Reihe endet, wo der Nachtragsblock beginnt — sonst könnte sie
    // eines Tages hineinwachsen und eine Altnummer zum zweiten Mal vergeben.
    const ceiling = !retro && options.retroBlockStart ? Math.trunc(options.retroBlockStart) - 1 : null;

    const docType = counterKey(year, options);

    // Gesperrt lesen: zwischen «wo steht der Zähler» und «setz ihn neu» darf
    // kein zweiter Vorgang dazwischenkommen.
    const currentRows: any[] = await client.$queryRaw`
        SELECT \`lastValue\` FROM \`DocumentCounter\`
        WHERE \`tenantId\` = ${serialTenantId} AND \`docType\` = ${docType}
        FOR UPDATE`;
    const current = currentRows.length ? Number(currentRows[0]?.lastValue ?? 0) : null;

    // Der Boden: Blockanfang und das, was im Bereich schon vergeben ist.
    const issued = await highestIssuedSeq(client, serialTenantId, year, blockStart, ceiling);
    const floor = Math.max(blockStart, issued + 1, (current ?? 0) + 1);

    if (current !== null && current + 1 < floor) {
        // Der Zähler hinkt hinterher (neue Reihe, Übernahme) — er wird gehoben.
        await client.$executeRaw`
            UPDATE \`DocumentCounter\`
            SET \`lastValue\` = LAST_INSERT_ID(${floor}), \`updatedAt\` = NOW(3)
            WHERE \`tenantId\` = ${serialTenantId} AND \`docType\` = ${docType}`;
    } else {
        await client.$executeRaw`
            INSERT INTO \`DocumentCounter\` (\`tenantId\`, \`docType\`, \`lastValue\`, \`updatedAt\`)
            VALUES (${serialTenantId}, ${docType}, LAST_INSERT_ID(${floor}), NOW(3))
            ON DUPLICATE KEY UPDATE
                \`lastValue\` = LAST_INSERT_ID(GREATEST(\`lastValue\` + 1, ${floor})),
                \`updatedAt\` = NOW(3)`;
    }

    const rows: any[] = await client.$queryRaw`SELECT LAST_INSERT_ID() AS \`seq\``;
    const seq = Number(rows?.[0]?.seq ?? 0);
    if (!Number.isFinite(seq) || seq < 1) throw new Error('Seriennummer konnte nicht vergeben werden.');
    if (ceiling !== null && seq > ceiling) {
        throw Object.assign(
            new Error('Die laufende Serie ist am Nachtragsblock angekommen; bitte den Block anheben.'),
            { status: 409, code: 'SERIAL_BLOCK_FULL' },
        );
    }

    return { serialNumber: formatPanelSerial(year, seq, digits), year, seq, isRetro: retro };
};

/**
 * `count` Nummern am Stück (ein Auftrag über zehn gleiche Schränke zieht zehn).
 * Nacheinander gezogen, damit jede Nummer durch dieselbe Sperre geht.
 */
export const nextPanelSerials = async (
    serialTenantId: string,
    count: number,
    options: PanelSerialOptions = {},
    tx?: any,
): Promise<PanelSerial[]> => {
    const serials: PanelSerial[] = [];
    for (let index = 0; index < Math.max(0, Math.trunc(count)); index += 1) {
        serials.push(await nextPanelSerial(serialTenantId, options, tx));
    }
    return serials;
};
