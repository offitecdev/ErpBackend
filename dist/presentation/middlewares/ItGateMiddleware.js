"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireItGate = exports.isValidItGateTicket = exports.issueItGateTicket = exports.verifyItGatePassword = exports.isItGateConfigured = exports.IT_GATE_HEADER = void 0;
const crypto_1 = __importDefault(require("crypto"));
/*
 * IT-Schleuse — das gemeinsame Kennwort der IT-Administration.
 *
 * Bis zum Produkt-Upload (17.08.2026) war die Schleuse reine ANZEIGE: das
 * Frontend fragte das Kennwort ab, merkte sich ein Häkchen im sessionStorage und
 * öffnete die Seite. Für Einstellungsseiten reicht das, weil dahinter jeder
 * einzelne Aufruf noch durch `requirePermission` läuft.
 *
 * Der Produkt-Upload hat diese zweite Schranke NICHT (die IT trägt nicht
 * zwingend das Lagerrecht), also muss die Schleuse hier serverseitig gelten.
 * Dafür gibt `/settings/it-gate/verify` nach richtigem Kennwort einen kurzen
 * Ausweis aus, den geschützte Aufrufe im Kopf `x-it-gate` mitschicken.
 *
 * Der Ausweis ist ein HMAC über Person + Ablaufzeit:
 *   - zustandslos, also über mehrere Serverinstanzen hinweg gültig,
 *   - an die angemeldete Person gebunden — ein fremder Ausweis passt nicht.
 *
 * Wie die Schleuse insgesamt ist das eine Hürde, keine kryptografische
 * Absicherung: wer das Kennwort kennt, ist drin.
 *
 * ── ZWEI KORREKTUREN (22.09.2026) ───────────────────────────────────────────
 *
 * 1. DAS KENNWORT STAND IM QUELLTEXT. Hier stand
 *    `process.env.OFFITEC_IT_GATE_PASSWORD || '162627'` — und weil die
 *    Umgebungsvariable nirgends gesetzt war, GALT die Voreinstellung. Wer den
 *    Quelltext (oder seine Vorgeschichte) lesen konnte, kannte das Kennwort.
 *    Ohne gesetztes Kennwort ist die Schleuse jetzt GESCHLOSSEN, nicht offen:
 *    sie antwortet 503, statt auf eine bekannte Zeichenkette hereinzufallen.
 *
 * 2. DASSELBE KENNWORT WAR DER SCHLÜSSEL DER AUSWEISE. Der HMAC wurde mit dem
 *    Kennwort als Schlüssel gebildet. Wer die Zeichenkette kannte, brauchte die
 *    Schleuse gar nicht mehr zu durchlaufen: er rechnete sich einen gültigen
 *    Ausweis für die eigene Personenkennung selbst aus und ging damit direkt an
 *    `requireItGate` vorbei. Der Ausweisschlüssel wird jetzt aus dem
 *    Hauptschlüssel der Anwendung ABGELEITET (HKDF, eigenes Label — dasselbe
 *    Verfahren wie bei den Mail-Geheimnissen) und hat mit dem eingetippten
 *    Kennwort nichts mehr zu tun.
 *
 *    Der Kennwortwechsel entwertet damit nicht mehr automatisch alle Ausweise.
 *    Das ist der Preis; er ist klein (ein Ausweis lebt einen Arbeitstag) und
 *    steht gegen einen Schlüssel, den man erraten kann, indem man das Kennwort
 *    errät.
 */
/** Kopfzeile, in der geschützte Aufrufe den Ausweis mitschicken. */
exports.IT_GATE_HEADER = 'x-it-gate';
/** Ein Arbeitstag — danach fragt die Schleuse erneut nach dem Kennwort. */
const TICKET_TTL_MS = 8 * 60 * 60_000;
/** Das Kennwort der Schleuse. Leer = die Schleuse ist zu (kein Rückfallwert). */
const gatePassword = () => (process.env.OFFITEC_IT_GATE_PASSWORD || '').trim();
/** Ist die Schleuse überhaupt eingerichtet? Sonst antworten die Wege 503. */
const isItGateConfigured = () => gatePassword().length > 0;
exports.isItGateConfigured = isItGateConfigured;
/**
 * Kennwortvergleich in konstanter Zeit. Verglichen werden die SHA-256-Abdrücke,
 * damit auch die LÄNGE des eingegebenen Kennworts nichts verrät —
 * `timingSafeEqual` verlangt gleich lange Puffer, und ein Längenvergleich davor
 * wäre genau die Auskunft, die man nicht geben will.
 */
const verifyItGatePassword = (input) => {
    const expected = gatePassword();
    if (!expected)
        return false;
    const digest = (value) => crypto_1.default.createHash('sha256').update(value, 'utf8').digest();
    return crypto_1.default.timingSafeEqual(digest(String(input ?? '')), digest(expected));
};
exports.verifyItGatePassword = verifyItGatePassword;
/**
 * Der Schlüssel, mit dem Ausweise unterschrieben werden — NICHT das Kennwort.
 *
 * Vorzug hat ein eigens gesetztes `OFFITEC_IT_GATE_TICKET_SECRET`; sonst wird
 * er aus `OFFITEC_CRYPTO_MASTER_KEY` abgeleitet. Dieser Hauptschlüssel muss
 * ohnehin vorhanden sein (ohne ihn läuft der Server gar nicht erst an, siehe
 * prisma.client.ts), deshalb braucht die Korrektur keine neue Pflichtangabe in
 * der Umgebung.
 */
let cachedTicketKey = null;
const ticketKey = () => {
    if (cachedTicketKey)
        return cachedTicketKey;
    const explicit = (process.env.OFFITEC_IT_GATE_TICKET_SECRET || '').trim();
    if (explicit) {
        cachedTicketKey = Buffer.from(explicit, 'utf8');
        return cachedTicketKey;
    }
    const master = (process.env.OFFITEC_CRYPTO_MASTER_KEY || '').trim();
    if (!master) {
        throw new Error('OFFITEC_CRYPTO_MASTER_KEY fehlt: IT-Schleuse kann keine Ausweise ausstellen.');
    }
    cachedTicketKey = Buffer.from(crypto_1.default.hkdfSync('sha256', master, 'offitec-it-gate', 'it-gate-ticket-v1', 32));
    return cachedTicketKey;
};
const sign = (employeeId, expiresAt) => crypto_1.default.createHmac('sha256', ticketKey())
    .update(`${employeeId}.${expiresAt}`)
    .digest('base64url');
/** Ausweis für die angemeldete Person (nach geprüftem Kennwort). */
const issueItGateTicket = (employeeId) => {
    const expiresAt = Date.now() + TICKET_TTL_MS;
    return { ticket: `${expiresAt}.${sign(employeeId, expiresAt)}`, expiresAt };
};
exports.issueItGateTicket = issueItGateTicket;
/** Gültig = Form stimmt, nicht abgelaufen, Unterschrift passt zur Person. */
const isValidItGateTicket = (employeeId, raw) => {
    const value = String(raw ?? '');
    const separator = value.indexOf('.');
    if (separator <= 0)
        return false;
    const expiresAt = Number(value.slice(0, separator));
    const signature = value.slice(separator + 1);
    if (!signature || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
        return false;
    const expected = Buffer.from(sign(employeeId, expiresAt));
    const provided = Buffer.from(signature);
    // timingSafeEqual verlangt gleiche Länge — die Längenprüfung davor verrät
    // nichts, weil die Länge der Unterschrift ohnehin fest ist.
    return provided.length === expected.length && crypto_1.default.timingSafeEqual(provided, expected);
};
exports.isValidItGateTicket = isValidItGateTicket;
/**
 * Wächter für Aufrufe, die NUR die IT ausführen darf (Produkt-Upload).
 * Steht IMMER hinter `requireAuth` — die Person kommt aus dem Zugangstoken.
 */
const requireItGate = (req, res, next) => {
    const user = req.user;
    if (!user?.id) {
        return res.status(401).json({ error: 'Anmeldung erforderlich.' });
    }
    if (!(0, exports.isItGateConfigured)()) {
        // Fail closed: ohne eingerichtetes Kennwort geht niemand durch.
        return res.status(503).json({
            error: 'IT-Schleuse ist nicht eingerichtet. Bitte OFFITEC_IT_GATE_PASSWORD setzen.',
        });
    }
    if (!(0, exports.isValidItGateTicket)(user.id, req.header(exports.IT_GATE_HEADER))) {
        return res.status(403).json({ error: 'IT-Schleuse: bitte das Kennwort erneut eingeben.' });
    }
    return next();
};
exports.requireItGate = requireItGate;
//# sourceMappingURL=ItGateMiddleware.js.map