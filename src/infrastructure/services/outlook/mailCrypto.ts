import crypto from "crypto";

/**
 * Verschlüsselung für Geheimnisse der Outlook-Anbindung (OAuth-Refresh-Tokens,
 * das Client-Secret der App-Registrierung). Ruht in der DB als
 * `enc:v1:<base64(iv|tag|ciphertext)>` — dasselbe AES-256-GCM-Verfahren wie
 * das DB-Passwort in `prisma.client.ts`, aber mit einem ABGELEITETEN Schlüssel:
 * ein Leck dieser Spalten darf nicht zugleich den DB-Schlüssel preisgeben.
 *
 * Ohne `OFFITEC_CRYPTO_MASTER_KEY` läuft der Server gar nicht erst an
 * (prisma.client.ts wirft), darum darf hier hart darauf vertraut werden.
 */
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;
const deriveKey = (): Buffer => {
    if (cachedKey) return cachedKey;
    const master = process.env.OFFITEC_CRYPTO_MASTER_KEY || "";
    if (!master) throw new Error("OFFITEC_CRYPTO_MASTER_KEY fehlt: Mail-Geheimnisse können nicht verschlüsselt werden.");
    cachedKey = crypto.hkdfSync("sha256", master, "offitec-mail", "mail-secrets-v1", 32) as unknown as Buffer;
    cachedKey = Buffer.from(cachedKey);
    return cachedKey;
};

export const encryptSecret = (plain: string): string => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
};

export const decryptSecret = (stored: string | null | undefined): string | null => {
    if (!stored) return null;
    if (!stored.startsWith(PREFIX)) return stored; // Altbestand im Klartext (sollte nicht vorkommen)
    const buffer = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};

/** Signierter, kurzlebiger OAuth-`state` (kein DB-Zugriff nötig). */
export const signState = (payload: Record<string, unknown>, ttlMs = 10 * 60_000): string => {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }), "utf8").toString("base64url");
    const mac = crypto.createHmac("sha256", deriveKey()).update(body).digest("base64url");
    return `${body}.${mac}`;
};

export const verifyState = <T extends Record<string, unknown>>(state: string): T | null => {
    const [body, mac] = String(state || "").split(".");
    if (!body || !mac) return null;
    const expected = crypto.createHmac("sha256", deriveKey()).update(body).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (!parsed || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
        return parsed as T;
    } catch {
        return null;
    }
};
