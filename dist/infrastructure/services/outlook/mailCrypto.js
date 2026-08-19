"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyState = exports.signState = exports.decryptSecret = exports.encryptSecret = void 0;
const crypto_1 = __importDefault(require("crypto"));
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
let cachedKey = null;
const deriveKey = () => {
    if (cachedKey)
        return cachedKey;
    const master = process.env.OFFITEC_CRYPTO_MASTER_KEY || "";
    if (!master)
        throw new Error("OFFITEC_CRYPTO_MASTER_KEY fehlt: Mail-Geheimnisse können nicht verschlüsselt werden.");
    cachedKey = crypto_1.default.hkdfSync("sha256", master, "offitec-mail", "mail-secrets-v1", 32);
    cachedKey = Buffer.from(cachedKey);
    return cachedKey;
};
const encryptSecret = (plain) => {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", deriveKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
};
exports.encryptSecret = encryptSecret;
const decryptSecret = (stored) => {
    if (!stored)
        return null;
    if (!stored.startsWith(PREFIX))
        return stored; // Altbestand im Klartext (sollte nicht vorkommen)
    const buffer = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};
exports.decryptSecret = decryptSecret;
/** Signierter, kurzlebiger OAuth-`state` (kein DB-Zugriff nötig). */
const signState = (payload, ttlMs = 10 * 60_000) => {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }), "utf8").toString("base64url");
    const mac = crypto_1.default.createHmac("sha256", deriveKey()).update(body).digest("base64url");
    return `${body}.${mac}`;
};
exports.signState = signState;
const verifyState = (state) => {
    const [body, mac] = String(state || "").split(".");
    if (!body || !mac)
        return null;
    const expected = crypto_1.default.createHmac("sha256", deriveKey()).update(body).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto_1.default.timingSafeEqual(a, b))
        return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (!parsed || typeof parsed.exp !== "number" || parsed.exp < Date.now())
            return null;
        return parsed;
    }
    catch {
        return null;
    }
};
exports.verifyState = verifyState;
//# sourceMappingURL=mailCrypto.js.map