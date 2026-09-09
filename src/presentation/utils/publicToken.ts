import { Request } from 'express';

/**
 * ── SCHLÜSSEL FÜR ÖFFENTLICHE SEITEN ────────────────────────────────────────
 *
 * Unterschriftsseite, Terminbestätigung: beides Seiten, die eine Kundin ohne
 * Konto öffnet. Der Schlüssel (`nanoid(32)`) ist gut gewählt — er stand nur an
 * der denkbar schlechtesten Stelle, nämlich IM PFAD:
 *
 *     GET /signature-requests/public/<schlüssel>
 *
 * Ein Pfad ist kein Geheimnis. Er landet wörtlich im Zugriffsprotokoll
 * (`server.out.log`), im Verlauf des Browsers, im Protokoll jedes
 * Zwischenservers und im `Referer` jeder Seite, die von dort verlinkt. Wer
 * eines davon lesen darf, kann unterschreiben.
 *
 * Deshalb reist der Schlüssel jetzt im Kopf `X-Public-Token`. Der Pfad bleibt
 * als Rückfallweg lesbar: es sind Verweise unterwegs, die schon verschickt
 * sind, und ein zwischengespeichertes Oberflächenpaket ruft noch den alten Weg
 * auf. Für diesen Rückfallweg schwärzt `main.ts` den Pfad im Protokoll.
 */
export const PUBLIC_TOKEN_HEADER = 'x-public-token';

export const readPublicToken = (req: Request): string => {
    const fromHeader = req.header(PUBLIC_TOKEN_HEADER);
    if (fromHeader && fromHeader.trim()) return fromHeader.trim();
    // Rückfallweg: der alte Weg mit dem Schlüssel im Pfad.
    return String(req.params.token || '').trim();
};

/**
 * ── UND: EIN SCHLÜSSEL, DER NIE ABLÄUFT, IST EIN DAUERZUGANG ────────────────
 *
 * Beide Schlüssel galten unbegrenzt. Ein Verweis aus einer Mail von vor zwei
 * Jahren — in einem alten Postfach, einer Sicherung, einem weitergeleiteten
 * Verlauf — öffnete den Bericht heute noch.
 *
 * Die Frist braucht KEINE Spaltenänderung: beide Datensätze tragen bereits ein
 * Datum, an dem sie sinnvoll hängt.
 */
const readTtlDays = (envVar: string, fallback: number): number => {
    const parsed = Number.parseInt(String(process.env[envVar] || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Unterschriftsverweis: ab dem Ausstellen. 30 Tage sind für eine Unterschrift
 * reichlich; über `OFFITEC_SIGNATURE_LINK_TTL_DAYS` verstellbar.
 */
export const isSignatureLinkExpired = (createdAt: Date | null | undefined): boolean => {
    if (!createdAt) return false;
    const days = readTtlDays('OFFITEC_SIGNATURE_LINK_TTL_DAYS', 30);
    return Date.now() > createdAt.getTime() + days * DAY_MS;
};

/**
 * Terminverweis: ab dem geplanten Termin. Danach ist eine Bestätigung ohnehin
 * gegenstandslos — der Termin war. Über `OFFITEC_BOOKING_LINK_TTL_DAYS`
 * verstellbar; 7 Tage lassen Raum für einen verschobenen Termin.
 */
export const isBookingLinkExpired = (plannedDate: Date | null | undefined): boolean => {
    if (!plannedDate) return false;
    const days = readTtlDays('OFFITEC_BOOKING_LINK_TTL_DAYS', 7);
    return Date.now() > plannedDate.getTime() + days * DAY_MS;
};
