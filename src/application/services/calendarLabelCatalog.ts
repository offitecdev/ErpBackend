import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { DEFAULT_CALENDAR_LABELS, type CalendarLabelRole } from '../../shared/calendarLabels';

/**
 * Die Kalender-Etiketten EINES Mandanten — gelesen von der Leiste des
 * Kalenders, vom Auswahlfeld im Anlegefenster und von jedem Weg, der ein
 * Etikett auf einen Eintrag schreibt.
 *
 *   `listLabels`      — ALLE, ausgeblendete eingeschlossen (das
 *                       Verwaltungsfenster zeigt sie, die Leiste nicht). Hat
 *                       der Mandant noch keine, wird der Erstbestand angelegt.
 *   `sanitizeLabelId` — prüft ein hereingereichtes Etikett gegen den Mandanten.
 *   `roleLabelId`     — das SICHTBARE Etikett einer Rolle.
 */

export interface LabelRow {
    id: string;
    name: string;
    color: string;
    sortOrder: number;
    role: string | null;
    hidden: boolean;
}

export const LABEL_ORDER_BY = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];

const SELECT = { id: true, name: true, color: true, sortOrder: true, role: true, hidden: true } as const;

const read = (tenantId: string) =>
    prisma.calendarLabel.findMany({ where: { tenantId }, orderBy: LABEL_ORDER_BY, select: SELECT });

/**
 * Die Liste. Ist sie leer, bekommt der Mandant den Erstbestand — je Rolle ein
 * Etikett mit eigener Farbe. Das trifft nur einen NEU angelegten Mandanten:
 * die Migration hat es den bestehenden schon angelegt, und Wegräumen läuft
 * über `hidden` und nicht über Löschen, die Liste fällt also nicht von selbst
 * wieder auf null zurück.
 */
export const listLabels = async (tenantId: string): Promise<LabelRow[]> => {
    const rows = await read(tenantId);
    if (rows.length) return rows;

    await prisma.calendarLabel.createMany({
        data: DEFAULT_CALENDAR_LABELS.map((seed) => ({
            id: nanoid(12),
            tenantId,
            name: seed.name,
            color: seed.color,
            sortOrder: seed.sortOrder,
            role: seed.role,
            hidden: false,
        })),
        skipDuplicates: true,
    });
    return read(tenantId);
};

/**
 * Das Etikett aus einem Anfragekörper.
 *
 *   `undefined` — nicht mitgeschickt: eine Änderung lässt das bestehende
 *                 Etikett stehen.
 *   `null`      — ausdrücklich geleert («ohne Etikett»).
 *   Kennung     — geprüft: sie muss zu DIESEM Mandanten gehören. Ein fremdes
 *                 oder gelöschtes Etikett wird still zu `null`, statt den
 *                 ganzen Speichervorgang an einem Fremdschlüssel scheitern zu
 *                 lassen. Ein AUSGEBLENDETES bleibt erlaubt: es steht schon an
 *                 Einträgen, und ein Speichern soll es dort nicht abreissen.
 */
export const sanitizeLabelId = async (tenantId: string, raw: unknown): Promise<string | null | undefined> => {
    if (raw === undefined) return undefined;
    const id = String(raw ?? '').trim();
    if (!id) return null;
    const found = await prisma.calendarLabel.findFirst({ where: { id, tenantId }, select: { id: true } });
    return found?.id ?? null;
};

/**
 * Das SICHTBARE Etikett einer Rolle. Je Rolle gibt es höchstens eines; ist es
 * ausgeblendet oder gibt es keines, bleibt der Eintrag ohne Etikett.
 */
export const roleLabelId = async (tenantId: string, role: CalendarLabelRole): Promise<string | null> => {
    const found = await prisma.calendarLabel.findFirst({
        where: { tenantId, role, hidden: false },
        orderBy: LABEL_ORDER_BY,
        select: { id: true },
    });
    return found?.id ?? null;
};

/**
 * Das Etikett, mit dem ein NEU angelegter Eintrag startet. Die Oberfläche
 * schickt eines mit; fehlt es (ältere Clients, Anlage aus anderen Modulen),
 * greift der Vorschlag der Rolle. Ausdrückliches `null` bleibt `null` —
 * «ohne Etikett» ist eine Wahl.
 */
export const resolveNewLabelId = async (
    tenantId: string,
    raw: unknown,
    role: CalendarLabelRole,
): Promise<string | null> => {
    const picked = await sanitizeLabelId(tenantId, raw);
    if (picked !== undefined) return picked;
    /* Die Liste muss dafür schon stehen — bei einem frischen Mandanten legt
       `listLabels` sie hier an, sonst bekäme sein erster Termin kein Etikett. */
    await listLabels(tenantId);
    return roleLabelId(tenantId, role);
};
