"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatSecretForReading = exports.buildOtpAuthUri = exports.verifyTotpCode = exports.totpCodeForStep = exports.secondsLeftInStep = exports.currentTotpStep = exports.generateTotpSecret = exports.base32Decode = exports.base32Encode = exports.TOTP_WINDOW = exports.TOTP_DIGITS = exports.TOTP_PERIOD_SECONDS = void 0;
const crypto_1 = __importDefault(require("crypto"));
/**
 * ── ZEITBASIERTE EINMALCODES (TOTP, RFC 6238) ───────────────────────────────
 *
 * Der zweite Faktor der Anmeldung. Die Rechenvorschrift ist ein offener
 * Standard: Server und Telefon teilen EIN Geheimnis, beide rechnen aus der
 * laufenden Uhrzeit denselben sechsstelligen Code aus. Es wird nichts
 * verschickt — kein SMS-Weg, keine Zustellung, keine Kosten. Genau deshalb
 * funktioniert jede Authenticator-App damit; die Hausempfehlung ist Aegis.
 *
 * Absichtlich HANDGESCHRIEBEN statt einer Bibliothek: es sind rund achtzig
 * Zeilen aus dem Standardtext, sie hängen nur an `crypto`, und eine weitere
 * Abhängigkeit im Anmeldeweg wäre eine weitere Stelle, die jemand übernehmen
 * kann.
 *
 * Die Voreinstellungen entsprechen dem, was Aegis (und jede andere App) ohne
 * Nachfrage annimmt: HMAC-SHA1, sechs Stellen, dreissig Sekunden. Sie sind
 * KEINE Geschmacksfrage — wer hier etwas ändert, muss es in der `otpauth`-
 * Adresse mitschreiben, sonst rechnet das Telefon andere Codes als der Server.
 */
/** RFC 4648 Base32 — die Schreibweise, in der Authenticator-Apps Geheimnisse lesen. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Länge eines Zeitfensters. Ein Code lebt so lange. */
exports.TOTP_PERIOD_SECONDS = 30;
/** Stellen des Codes. */
exports.TOTP_DIGITS = 6;
/**
 * Wie viele Fenster VOR und NACH dem laufenden noch angenommen werden.
 * Eins heisst: die Uhr des Telefons darf eine halbe Minute daneben liegen.
 * Mehr wäre bequemer und würde jedem Rateversuch mehr Treffer schenken.
 */
exports.TOTP_WINDOW = 1;
const base32Encode = (buffer) => {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
};
exports.base32Encode = base32Encode;
/** Nimmt Leerzeichen, Kleinschreibung und `=`-Füllzeichen hin — so, wie Menschen abtippen. */
const base32Decode = (text) => {
    const cleaned = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of cleaned) {
        const index = ALPHABET.indexOf(char);
        if (index < 0)
            throw new Error('Base32: ungültiges Zeichen.');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
};
exports.base32Decode = base32Decode;
/**
 * Ein frisches Geheimnis. 20 Bytes = 160 Bit, die Länge, die RFC 4226 für
 * SHA-1 nennt, und die Länge, die Aegis beim Einlesen erwartet.
 */
const generateTotpSecret = (byteLength = 20) => (0, exports.base32Encode)(crypto_1.default.randomBytes(byteLength));
exports.generateTotpSecret = generateTotpSecret;
/** Das Zeitfenster, in dem ein Zeitpunkt liegt (Unixsekunden / 30). */
const currentTotpStep = (atMs = Date.now()) => Math.floor(atMs / 1000 / exports.TOTP_PERIOD_SECONDS);
exports.currentTotpStep = currentTotpStep;
/** Sekunden, die dem laufenden Fenster noch bleiben — die Anzeige zählt damit herunter. */
const secondsLeftInStep = (atMs = Date.now()) => exports.TOTP_PERIOD_SECONDS - (Math.floor(atMs / 1000) % exports.TOTP_PERIOD_SECONDS);
exports.secondsLeftInStep = secondsLeftInStep;
/**
 * HOTP (RFC 4226) über ein Zeitfenster: HMAC-SHA1 über den Zähler als
 * 8-Byte-Zahl, daraus die "dynamische Verkürzung" auf sechs Stellen.
 */
const totpCodeForStep = (secretBase32, step) => {
    const counter = Buffer.alloc(8);
    // Der Zähler ist 64 Bit; JavaScript rechnet mit 53 sicher — für eine
    // Sekundenzahl geteilt durch 30 reicht das bis weit hinter das Jahr 9999.
    counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
    counter.writeUInt32BE(step >>> 0, 4);
    const digest = crypto_1.default.createHmac('sha1', (0, exports.base32Decode)(secretBase32)).update(counter).digest();
    // Die "dynamische Verkürzung": die letzten vier Bit des Abschlusses zeigen
    // auf die vier Bytes, aus denen der Code gerechnet wird. `readUInt32BE`
    // statt vier Einzelzugriffen — SHA-1 liefert immer 20 Bytes, und `offset`
    // ist höchstens 15, der Lesevorgang liegt also stets im Puffer.
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = digest.readUInt32BE(offset) & 0x7fffffff;
    return String(binary % 10 ** exports.TOTP_DIGITS).padStart(exports.TOTP_DIGITS, '0');
};
exports.totpCodeForStep = totpCodeForStep;
/**
 * Prüft einen eingegebenen Code. Antwort ist das Fenster, das gepasst hat
 * (zum Fortschreiben des Wiederholungsschutzes) — oder `null`.
 *
 * Verglichen wird zeitkonstant: `timingSafeEqual` statt `===`, damit die
 * Antwortdauer nicht verrät, wie viele Stellen schon stimmten.
 */
const verifyTotpCode = (secretBase32, code, { atMs = Date.now(), notBeforeStep = null } = {}) => {
    const entered = String(code || '').replace(/\D/g, '');
    if (entered.length !== exports.TOTP_DIGITS)
        return null;
    const now = (0, exports.currentTotpStep)(atMs);
    for (let offset = -exports.TOTP_WINDOW; offset <= exports.TOTP_WINDOW; offset += 1) {
        const step = now + offset;
        if (notBeforeStep !== null && notBeforeStep !== undefined && step <= notBeforeStep)
            continue;
        const expected = Buffer.from((0, exports.totpCodeForStep)(secretBase32, step));
        const actual = Buffer.from(entered);
        if (expected.length === actual.length && crypto_1.default.timingSafeEqual(expected, actual))
            return step;
    }
    return null;
};
exports.verifyTotpCode = verifyTotpCode;
/**
 * Die Adresse, die als QR-Bild gezeigt wird. `otpauth://` ist der Standard,
 * den Aegis (und jede andere App) beim Scannen liest.
 *
 * Der Aussteller steht ZWEIMAL darin — einmal im Pfad, einmal als Feld. So
 * will es die Schreibweise von Google, und ältere Apps lesen nur eines von
 * beiden. Beide Teile müssen prozentkodiert sein, sonst zerlegt ein
 * Doppelpunkt in der Firmenbezeichnung die Adresse.
 */
const buildOtpAuthUri = ({ secretBase32, account, issuer, }) => {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    const params = new URLSearchParams({
        secret: secretBase32,
        issuer,
        algorithm: 'SHA1',
        digits: String(exports.TOTP_DIGITS),
        period: String(exports.TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
};
exports.buildOtpAuthUri = buildOtpAuthUri;
/** Vierergruppen — abtippen ohne QR-Bild wird damit erträglich. */
const formatSecretForReading = (secretBase32) => (secretBase32.match(/.{1,4}/g) || []).join(' ');
exports.formatSecretForReading = formatSecretForReading;
//# sourceMappingURL=totp.js.map