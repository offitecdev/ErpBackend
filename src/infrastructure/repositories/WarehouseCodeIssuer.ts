import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import { warehouseError } from '../../domain/services/warehouse';
import {
    codeVariants,
    erpPrefix,
    formatErpCode,
    gs1InternalBarcode,
    MAX_BARCODE_NUMBER,
} from '../../domain/services/warehouseCodes';

/**
 * ── ERP-CODES UND BARCODES ZIEHEN (26.09.2026, zweiter Durchgang) ───────────
 *
 * Läuft IMMER innerhalb eines Vorgangs (`prisma.$transaction(async tx => …)`),
 * zusammen mit dem Schreiben der Karte: fällt das Schreiben aus, gehen auch
 * die Nummern zurück.
 *
 *   · Laufnummer der Gruppe: EIN `UPDATE … lastNumber = lastNumber + n`
 *     reserviert den ganzen Block und hält die Zeile gesperrt, bis der
 *     Vorgang endet — zwei gleichzeitige Karten bekommen verschiedene Nummern.
 *   · Barcodezähler der Firma (depo_ayarlar): dasselbe, als «einfügen oder
 *     erhöhen» in einer Anweisung.
 *   · Steht ein Code schon auf einer Karte (Altbestand), wird er
 *     übersprungen; ein geschlossener Block wird einmal übersprungen.
 */

/** Der Vorgang des gemeinsamen (erweiterten) Clients — nicht `Prisma.TransactionClient`. */
export type WarehouseTx = Parameters<Extract<Parameters<typeof prisma.$transaction>[0], (...args: never[]) => unknown>>[0];
type Tx = WarehouseTx;

/** Zeitstempel für rohe Anweisungen — UTC wie jeder Prisma-Zeitstempel. */
const sqlNow = (): string => new Date().toISOString().slice(0, 23).replace('T', ' ');

const range = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let n = from; n <= to; n += 1) out.push(n);
    return out;
};

/** Vorgänge mit Nummern: ein Aktarım von zweitausend Zeilen braucht Zeit. */
export const CODE_TX_OPTIONS = { timeout: 180_000, maxWait: 20_000 } as const;
export const CARD_TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const;

/**
 * `count` ERP-Codes der Gruppe, in aufsteigender Reihenfolge.
 * Fehler: GROUP_NOT_FOUND (Gruppe weg), GROUP_CODE_MISSING (Gruppe ohne Kürzel).
 */
export const reserveErpCodes = async (tx: Tx, tenantId: string, groupId: string, count: number): Promise<string[]> => {
    if (count <= 0) return [];
    const codes: string[] = [];
    let jumped = false;
    for (let round = 0; codes.length < count && round < 40; round += 1) {
        const need = count - codes.length;
        const changed = await tx.$executeRaw`
            UPDATE depo_malzeme_gruplari SET lastNumber = lastNumber + ${need}
             WHERE id = ${groupId} AND tenantId = ${tenantId}`;
        if (!changed) throw warehouseError('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 400 });

        const [group] = await tx.$queryRaw<Array<{ lastNumber: unknown; code: string | null; categoryCode: string | null }>>`
            SELECT g.lastNumber, g.code, c.code AS categoryCode
              FROM depo_malzeme_gruplari g
              JOIN depo_ana_kategoriler c ON c.id = g.categoryId
             WHERE g.id = ${groupId}`;
        if (!group?.code || !group.categoryCode) {
            throw warehouseError('GROUP_CODE_MISSING', 'Diese Materialgruppe hat noch kein Kürzel.', { status: 409 });
        }
        const last = Number(group.lastNumber);
        const candidates = range(last - need + 1, last).map((n) => formatErpCode(group.categoryCode!, group.code!, n));
        const taken = await tx.$queryRaw<Array<{ erpCode: string }>>`
            SELECT erpCode FROM depo_urun_kartlari
             WHERE tenantId = ${tenantId} AND erpCode IN (${Prisma.join(candidates)})`;
        const takenSet = new Set(taken.map((row) => String(row.erpCode).toUpperCase()));
        const free = candidates.filter((code) => !takenSet.has(code));
        codes.push(...free);

        if (!free.length && !jumped) {
            // Ein geschlossener Block Vergebenes: einmal über die höchste
            // vergebene Nummer dieses Präfixes springen.
            jumped = true;
            const prefix = erpPrefix(group.categoryCode, group.code);
            const [high] = await tx.$queryRaw<Array<{ high: unknown }>>`
                SELECT MAX(CAST(SUBSTRING(erpCode, ${prefix.length + 1}) AS UNSIGNED)) AS high
                  FROM depo_urun_kartlari
                 WHERE tenantId = ${tenantId}
                   AND erpCode LIKE ${`${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}
                   AND SUBSTRING(erpCode, ${prefix.length + 1}) REGEXP '^[0-9]+$'`;
            const highest = Number(high?.high ?? 0);
            if (highest > last) {
                await tx.$executeRaw`
                    UPDATE depo_malzeme_gruplari SET lastNumber = GREATEST(lastNumber, ${highest})
                     WHERE id = ${groupId} AND tenantId = ${tenantId}`;
            }
        }
    }
    if (codes.length < count) throw new Error('Depo: keine freien ERP-Codes gefunden.');
    return codes.slice(0, count);
};

/**
 * `count` firmeninterne GS1-Barcodes (04 + zehn Stellen + Prüfziffer). Ein
 * Code, der schon als Barcode oder Herstellerbarcode einer Karte steht — auch
 * als Barcode eines ihrer Lieferanten, auch in seiner zwölfstelligen
 * UPC-Form —, wird übersprungen.
 */
export const reserveBarcodes = async (tx: Tx, tenantId: string, count: number): Promise<string[]> => {
    if (count <= 0) return [];
    const barcodes: string[] = [];
    for (let round = 0; barcodes.length < count && round < 20; round += 1) {
        const need = count - barcodes.length;
        await tx.$executeRaw`
            INSERT INTO depo_ayarlar (tenantId, barcodeLastNumber, updatedAt)
            VALUES (${tenantId}, ${need}, ${sqlNow()})
            ON DUPLICATE KEY UPDATE barcodeLastNumber = barcodeLastNumber + ${need}`;
        const [row] = await tx.$queryRaw<Array<{ barcodeLastNumber: unknown }>>`
            SELECT barcodeLastNumber FROM depo_ayarlar WHERE tenantId = ${tenantId}`;
        const last = Number(row?.barcodeLastNumber ?? 0);
        if (!Number.isFinite(last) || last > MAX_BARCODE_NUMBER) {
            throw warehouseError('BARCODE_RANGE_EXHAUSTED', 'Der Barcodebereich der Firma ist erschöpft.', { status: 409 });
        }
        const candidates = range(last - need + 1, last).map(gs1InternalBarcode);
        const probes = [...new Set(candidates.flatMap(codeVariants))];
        const taken = await tx.$queryRaw<Array<{ code: string }>>`
            SELECT barcode AS code FROM depo_urun_kartlari
             WHERE tenantId = ${tenantId} AND barcode IN (${Prisma.join(probes)})
            UNION
            SELECT manufacturerBarcode AS code FROM depo_urun_kartlari
             WHERE tenantId = ${tenantId} AND manufacturerBarcode IN (${Prisma.join(probes)})
            UNION
            SELECT barcode AS code FROM depo_urun_tedarikcileri
             WHERE tenantId = ${tenantId} AND barcode IN (${Prisma.join(probes)})`;
        const takenSet = new Set(taken.map((entry) => String(entry.code)));
        barcodes.push(...candidates.filter((code) => !codeVariants(code).some((variant) => takenSet.has(variant))));
    }
    if (barcodes.length < count) throw new Error('Depo: keine freien Barcodes gefunden.');
    return barcodes.slice(0, count);
};
