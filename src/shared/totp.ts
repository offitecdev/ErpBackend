import crypto from 'crypto';

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
export const TOTP_PERIOD_SECONDS = 30;
/** Stellen des Codes. */
export const TOTP_DIGITS = 6;
/**
 * Wie viele Fenster VOR und NACH dem laufenden noch angenommen werden.
 * Eins heisst: die Uhr des Telefons darf eine halbe Minute daneben liegen.
 * Mehr wäre bequemer und würde jedem Rateversuch mehr Treffer schenken.
 */
export const TOTP_WINDOW = 1;

export const base32Encode = (buffer: Buffer): string => {
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
    if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
};

/** Nimmt Leerzeichen, Kleinschreibung und `=`-Füllzeichen hin — so, wie Menschen abtippen. */
export const base32Decode = (text: string): Buffer => {
    const cleaned = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of cleaned) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) throw new Error('Base32: ungültiges Zeichen.');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
};

/**
 * Ein frisches Geheimnis. 20 Bytes = 160 Bit, die Länge, die RFC 4226 für
 * SHA-1 nennt, und die Länge, die Aegis beim Einlesen erwartet.
 */
export const generateTotpSecret = (byteLength = 20): string =>
    base32Encode(crypto.randomBytes(byteLength));

/** Das Zeitfenster, in dem ein Zeitpunkt liegt (Unixsekunden / 30). */
export const currentTotpStep = (atMs: number = Date.now()): number =>
    Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);

/** Sekunden, die dem laufenden Fenster noch bleiben — die Anzeige zählt damit herunter. */
export const secondsLeftInStep = (atMs: number = Date.now()): number =>
    TOTP_PERIOD_SECONDS - (Math.floor(atMs / 1000) % TOTP_PERIOD_SECONDS);

/**
 * HOTP (RFC 4226) über ein Zeitfenster: HMAC-SHA1 über den Zähler als
 * 8-Byte-Zahl, daraus die "dynamische Verkürzung" auf sechs Stellen.
 */
export const totpCodeForStep = (secretBase32: string, step: number): string => {
    const counter = Buffer.alloc(8);
    // Der Zähler ist 64 Bit; JavaScript rechnet mit 53 sicher — für eine
    // Sekundenzahl geteilt durch 30 reicht das bis weit hinter das Jahr 9999.
    counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
    counter.writeUInt32BE(step >>> 0, 4);

    const digest = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
    // Die "dynamische Verkürzung": die letzten vier Bit des Abschlusses zeigen
    // auf die vier Bytes, aus denen der Code gerechnet wird. `readUInt32BE`
    // statt vier Einzelzugriffen — SHA-1 liefert immer 20 Bytes, und `offset`
    // ist höchstens 15, der Lesevorgang liegt also stets im Puffer.
    const offset = (digest[digest.length - 1] as number) & 0x0f;
    const binary = digest.readUInt32BE(offset) & 0x7fffffff;

    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

interface VerifyOptions {
    /** Prüfzeitpunkt — nur für Tests. */
    atMs?: number;
    /**
     * Das zuletzt ANGENOMMENE Fenster dieser Person. Fenster bis
     * einschliesslich dieses Wertes werden abgelehnt: ein Code gilt genau
     * einmal. Ohne das könnte ein abgelesener Code (Schulterblick, Protokoll
     * eines Zwischenservers) innerhalb seiner dreissig Sekunden ein zweites
     * Mal anmelden.
     */
    notBeforeStep?: number | null;
}

/**
 * Prüft einen eingegebenen Code. Antwort ist das Fenster, das gepasst hat
 * (zum Fortschreiben des Wiederholungsschutzes) — oder `null`.
 *
 * Verglichen wird zeitkonstant: `timingSafeEqual` statt `===`, damit die
 * Antwortdauer nicht verrät, wie viele Stellen schon stimmten.
 */
export const verifyTotpCode = (
    secretBase32: string,
    code: string,
    { atMs = Date.now(), notBeforeStep = null }: VerifyOptions = {},
): number | null => {
    const entered = String(code || '').replace(/\D/g, '');
    if (entered.length !== TOTP_DIGITS) return null;

    const now = currentTotpStep(atMs);
    for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
        const step = now + offset;
        if (notBeforeStep !== null && notBeforeStep !== undefined && step <= notBeforeStep) continue;
        const expected = Buffer.from(totpCodeForStep(secretBase32, step));
        const actual = Buffer.from(entered);
        if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return step;
    }
    return null;
};

/**
 * Die Adresse, die als QR-Bild gezeigt wird. `otpauth://` ist der Standard,
 * den Aegis (und jede andere App) beim Scannen liest.
 *
 * Der Aussteller steht ZWEIMAL darin — einmal im Pfad, einmal als Feld. So
 * will es die Schreibweise von Google, und ältere Apps lesen nur eines von
 * beiden. Beide Teile müssen prozentkodiert sein, sonst zerlegt ein
 * Doppelpunkt in der Firmenbezeichnung die Adresse.
 */
export const buildOtpAuthUri = ({
    secretBase32,
    account,
    issuer,
}: {
    secretBase32: string;
    account: string;
    issuer: string;
}): string => {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    const params = new URLSearchParams({
        secret: secretBase32,
        issuer,
        algorithm: 'SHA1',
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
};

/** Vierergruppen — abtippen ohne QR-Bild wird damit erträglich. */
export const formatSecretForReading = (secretBase32: string): string =>
    (secretBase32.match(/.{1,4}/g) || []).join(' ');
