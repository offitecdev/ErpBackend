"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireItGate = exports.isValidItGateTicket = exports.issueItGateTicket = exports.IT_GATE_HEADER = exports.IT_GATE_PASSWORD = void 0;
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
 * Der Ausweis ist ein HMAC über Person + Ablaufzeit mit dem Kennwort als
 * Schlüssel:
 *   - kein neues Geheimnis in der Umgebung (das Kennwort ist schon da),
 *   - zustandslos, also über mehrere Serverinstanzen hinweg gültig,
 *   - an die angemeldete Person gebunden — ein fremder Ausweis passt nicht,
 *   - und mit dem Kennwortwechsel verfallen ALLE Ausweise von selbst.
 *
 * Wie die Schleuse insgesamt ist das eine Hürde, keine kryptografische
 * Absicherung: wer das Kennwort kennt, ist drin.
 */
exports.IT_GATE_PASSWORD = process.env.OFFITEC_IT_GATE_PASSWORD || '162627';
/** Kopfzeile, in der geschützte Aufrufe den Ausweis mitschicken. */
exports.IT_GATE_HEADER = 'x-it-gate';
/** Ein Arbeitstag — danach fragt die Schleuse erneut nach dem Kennwort. */
const TICKET_TTL_MS = 8 * 60 * 60_000;
const sign = (employeeId, expiresAt) => crypto_1.default.createHmac('sha256', exports.IT_GATE_PASSWORD)
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
    if (!(0, exports.isValidItGateTicket)(user.id, req.header(exports.IT_GATE_HEADER))) {
        return res.status(403).json({ error: 'IT-Schleuse: bitte das Kennwort erneut eingeben.' });
    }
    return next();
};
exports.requireItGate = requireItGate;
//# sourceMappingURL=ItGateMiddleware.js.map