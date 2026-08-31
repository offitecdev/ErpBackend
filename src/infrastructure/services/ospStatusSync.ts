import prisma from '../database/prisma.client';
import { OSP_WIRE_STATUS, reportOspOfferStatus, type OspSalesmanDto } from './OspClient';

/**
 * ── OSP-STANDMELDUNG (19.09.2026) ────────────────────────────────────────────
 * Der Bearbeitungsstand einer OSP-Anfrage wird NIRGENDS von Hand gesetzt: er
 * folgt der Arbeit an der Offerte (offer-integration-api.md, "Required workflow
 * in the sales system"). Damit die Meldung an die OSP an JEDER Stelle gleich
 * aussieht — auf der OSP-Seite, beim Import und beim Mailversand der Offerte —
 * steht sie hier einmal und wird von dort geholt.
 *
 * Alles ist BEST-EFFORT und wirft nie: eine nicht erreichbare OSP darf weder
 * eine Zuweisung noch einen Mailversand scheitern lassen. Ausgang und Fehler
 * stehen danach an der Zeile (lastReport*).
 */

/**
 * Die §3-Visitenkarte einer Zeile. Beim Wählen der Person wird sie ganz
 * abgelegt (Vorname, Nachname, Rufnummer); ältere Zeilen kennen nur den
 * zusammengesetzten Anzeigenamen — der wird dann am ersten Leerzeichen
 * geteilt, weil mehr über sie nicht bekannt ist.
 */
export const ospSalesmanOf = (doc: any): OspSalesmanDto | null => {
    const email = (doc?.salespersonEmail || '').trim();
    if (!email) return null;
    const stored = doc?.salespersonProfile;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        return { ...(stored as OspSalesmanDto), email };
    }
    const [first, ...rest] = String(doc?.salespersonName || '').trim().split(/\s+/);
    return { email, name: first || null, surname: rest.join(' ') || null };
};

export interface OspReportableDocument {
    id: string;
    reference: string;
    salespersonEmail?: string | null;
    salespersonName?: string | null;
    salespersonProfile?: any;
}

/** Meldung an die OSP + Protokoll an der Zeile — Best-Effort, wirft nie. */
export const reportOspDocumentStatus = async (
    setting: any | null,
    doc: OspReportableDocument,
    internalStatus: string,
): Promise<void> => {
    const wireStatus = OSP_WIRE_STATUS[internalStatus];
    if (!wireStatus || !setting) return;
    const result = await reportOspOfferStatus(setting, doc.reference, wireStatus, ospSalesmanOf(doc));
    await (prisma as any).ospDocument.update({
        where: { id: doc.id },
        data: result.ok
            ? { lastReportedStatus: wireStatus, lastReportAt: new Date(), lastReportError: null }
            : {
                lastReportError: result.skipped
                    ? 'OSP-Zugang nicht konfiguriert (Basisadresse/Schlüssel fehlen).'
                    : result.error || 'Unbekannter Fehler.',
            },
    }).catch(() => undefined);
};

/**
 * Die Angebotsmail einer Offerte ist HINAUS — kam die Offerte aus der OSP, ist
 * ihre Anfrage damit erledigt: "Gesendet" bei uns, `offer has been sent` drüben.
 *
 * Nur ein ECHTER Versand zählt (Vertrag: "'Sent' means that the actual offer
 * email was delivered successfully"). Eine Vorschau ohne Mailkonto ruft hier
 * gar nicht erst an.
 *
 * Der Aufrufer wartet nicht: die Kundschaft hat die Offerte bereits, und ob die
 * OSP antwortet, darf den Versand nicht aufhalten. Scheitert die Meldung, steht
 * der Grund an der Zeile und der nächste Abgleich holt sie nach.
 */
export const markOspOfferSent = async (tenderId: string): Promise<void> => {
    const doc = await (prisma as any).ospDocument.findFirst({
        where: { tenderId },
        select: {
            id: true, tenantId: true, reference: true, status: true,
            salespersonEmail: true, salespersonName: true, salespersonProfile: true,
        },
    }).catch(() => null);
    if (!doc) return;
    // Zurückgezogene Anfragen bleiben zurückgezogen: die OSP hat ihre Seite
    // abgeräumt, eine Meldung darauf würde eine Anfrage wiederbeleben, die es
    // drüben nicht mehr gibt.
    if (doc.status === 'WITHDRAWN' || doc.status === 'SENT') return;

    await (prisma as any).ospDocument.update({
        where: { id: doc.id },
        data: { status: 'SENT' },
    }).catch(() => undefined);

    // Ohne Verkäufer:in lehnt die OSP "offer has been sent" mit 400 ab (§3).
    // Der Stand bei uns stimmt trotzdem — gemeldet wird dann erst, wenn jemand
    // zugewiesen ist.
    if (!doc.salespersonEmail) return;
    const setting = await (prisma as any).ospSetting.findUnique({
        where: { tenantId: doc.tenantId },
    }).catch(() => null);
    await reportOspDocumentStatus(setting, doc, 'SENT');
};
