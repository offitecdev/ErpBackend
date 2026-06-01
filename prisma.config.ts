// npm install --save-dev prisma dotenv
import "dotenv/config";
import { defineConfig } from "prisma/config";
import crypto from "crypto";

function decryptDatabasePassword(): string {
    const encryptedPayload = process.env.OFFITEC_DB_ENCRYPTED_PASS;
    const secretKey = process.env.OFFITEC_CRYPTO_MASTER_KEY;

    if (!encryptedPayload || !secretKey) {
        throw new Error("[OFFITEC FATAL] Şifreleme anahtarları eksik! Sistem başlatılamıyor.");
    }

    const key = Buffer.from(secretKey.padEnd(32, '\0').substring(0, 32), 'utf-8');
    const buffer = Buffer.from(encryptedPayload, 'base64');

    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const databaseUrl = process.env.DATABASE_URL || (() => {
    const dbUser = encodeURIComponent((process.env.OFFITEC_DB_USER || '').trim());
    const dbHost = (process.env.OFFITEC_DB_HOST || '').trim();
    const dbPort = (process.env.OFFITEC_DB_PORT || '3306').trim();
    const dbName = (process.env.OFFITEC_DB_NAME || '').trim();
    const dbPass = encodeURIComponent(decryptDatabasePassword());
    return `mysql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}`;
})();

const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL || databaseUrl.replace(/\/[^/]+$/, '/prisma_shadow');

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
    seed: "ts-node prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl: shadowDatabaseUrl,
  },
});
