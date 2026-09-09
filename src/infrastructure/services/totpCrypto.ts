import crypto from 'crypto';

/**
 * ── DAS TOTP-GEHEIMNIS IM RUHEZUSTAND ───────────────────────────────────────
 *
 * `Employee.totpSecret` ist der zweite Faktor. Läge es im Klartext in der
 * Tabelle, wäre eine ausgelesene Datenbank (Sicherung, Auskunftslücke,
 * abgezogener Dump) zugleich der zweite Faktor JEDER Person — die ganze
 * Massnahme wäre dann nur noch eine Unbequemlichkeit.
 *
 * Es ruht deshalb als `enc:v1:<base64(iv|tag|ciphertext)>`, AES-256-GCM, wie
 * die Mailgeheimnisse (`outlook/mailCrypto.ts`) und das Datenbankkennwort
 * (`database/prisma.client.ts`). Der Schlüssel wird aus
 * `OFFITEC_CRYPTO_MASTER_KEY` ABGELEITET, mit eigenem Verwendungszweck: ein
 * Leck dieser Spalte gibt weder den Hauptschlüssel noch die Mailgeheimnisse
 * preis, und umgekehrt.
 *
 * Ohne Hauptschlüssel läuft der Server ohnehin nicht an (prisma.client.ts
 * wirft beim Start), darum darf hier hart darauf vertraut werden.
 */
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;
const deriveKey = (): Buffer => {
    if (cachedKey) return cachedKey;
    const master = process.env.OFFITEC_CRYPTO_MASTER_KEY || '';
    if (!master) throw new Error('OFFITEC_CRYPTO_MASTER_KEY fehlt: TOTP-Geheimnisse können nicht verschlüsselt werden.');
    cachedKey = Buffer.from(
        crypto.hkdfSync('sha256', master, 'offitec-totp', 'totp-secrets-v1', 32) as unknown as ArrayBuffer,
    );
    return cachedKey;
};

export const encryptTotpSecret = (plain: string): string => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
};

/**
 * Gibt `null` zurück, wenn nichts da ist ODER der Inhalt nicht mehr lesbar ist
 * (verdrehter Hauptschlüssel, verfälschte Zeile). Ein unlesbares Geheimnis
 * darf die Anmeldung nicht mit einem Serverfehler abbrechen — der Weg
 * behandelt es wie "nicht eingerichtet" und führt durch die Einrichtung.
 */
export const decryptTotpSecret = (stored: string | null | undefined): string | null => {
    if (!stored) return null;
    if (!stored.startsWith(PREFIX)) return null;
    try {
        const buffer = Buffer.from(stored.slice(PREFIX.length), 'base64');
        const iv = buffer.subarray(0, 12);
        const tag = buffer.subarray(12, 28);
        const ciphertext = buffer.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
        console.error('[totpCrypto] Geheimnis nicht lesbar:', error instanceof Error ? error.message : error);
        return null;
    }
};
