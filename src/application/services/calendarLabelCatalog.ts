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

/**
 * DAS STATUS-ETIKETT FOLGT DEM TAG (03.09.2026).
 *
 * Vorgabe Samet: «Auf dem Kalender muss man SEHEN, was ein Termin ist — ein
 * vergangener ist abgeschlossen, einer von heute laufend, einer von morgen
 * geplant.» Die Farbe einer Karte ist ihr Etikett (CalendarPage, 25.08.2026);
 * also trägt ein Termin das Etikett der Rolle, die zu seinem Tag passt
 * (shared/appointmentDay.ts, labelRoleForAppointmentDay), und wechselt es,
 * wenn der Tag weitergeht.
 *
 * Aber nur, wenn er bis dahin ein STATUS-Etikett trug — «geplant», «laufend»
 * oder «abgeschlossen» — oder gar keines. Ein von Hand gewähltes Farbetikett
 * und die Besprechung bleiben, was sie sind: die Rolle sperrt nichts, und
 * eine bewusste Wahl wird nicht überschrieben. Ist das Etikett der Zielrolle
 * ausgeblendet, bleibt ebenfalls alles.
 *
 * Rückgabe: ein Teil von `data` für `appointment.update` — leer, wenn nichts
 * zu ändern ist. Der Tagesabschluss (MaintenanceReminderService) wendet
 * dieselbe Regel gebündelt auf den Bestand an.
 */
export const STATUS_LABEL_ROLES: ReadonlyArray<CalendarLabelRole> = ['PLANNED', 'ONGOING', 'DONE'];

export const dayLabelPatch = async (
    tenantId: string,
    currentLabelId: string | null | undefined,
    role: CalendarLabelRole,
): Promise<{ labelId?: string }> => {
    const target = await roleLabelId(tenantId, role);
    if (!target || target === currentLabelId) return {};
    if (currentLabelId) {
        const current = await prisma.calendarLabel.findFirst({ where: { id: currentLabelId, tenantId }, select: { role: true } });
        // Ein fremdes oder gelöschtes Etikett zählt wie keines.
        if (current && !(STATUS_LABEL_ROLES as ReadonlyArray<string>).includes(current.role || '')) return {};
    }
    return { labelId: target };
};

/** Der Abschluss durch Monteur oder Verantwortlichen: Etikett «abgeschlossen». */
export const completedLabelPatch = (tenantId: string, currentLabelId: string | null | undefined) =>
    dayLabelPatch(tenantId, currentLabelId, 'DONE');
