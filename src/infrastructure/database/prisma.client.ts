import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import mariadb from 'mariadb';
import crypto from 'crypto';
import { nanoid } from 'nanoid';

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

const rawDbUser = (process.env.OFFITEC_DB_USER || '').trim();
const dbUser = encodeURIComponent(rawDbUser);
const dbHost = (process.env.OFFITEC_DB_HOST || '').trim();
const dbPort = (process.env.OFFITEC_DB_PORT || '3306').trim();
const dbName = (process.env.OFFITEC_DB_NAME || '').trim();
const rawDbPass = decryptDatabasePassword();
const dbPass = encodeURIComponent(rawDbPass);
const databaseUrl = `mysql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}`;

process.env.DATABASE_URL = databaseUrl;


const adapter = new PrismaMariaDb({
    host: dbHost,
    port: Number(dbPort),
    user: rawDbUser,
    password: rawDbPass,
    database: dbName,
    connectionLimit: 10,
    minimumIdle: 4,
    keepAliveDelay: 30_000,
});

const COMPOSITE_PK_MODELS = new Set(['EmployeeRole', 'RolePermission']);

const prisma = new PrismaClient({
    adapter,
    errorFormat: 'pretty'
}).$extends({
    query: {
        $allModels: {
            async create({ model, args, query }) {
                const data = args.data as any;
                if (data && !data.id && !COMPOSITE_PK_MODELS.has(model as string)) {
                    data.id = nanoid(8);
                }
                return query(args);
            },
            async createMany({ model, args, query }) {
                if (args.data && Array.isArray((args as any).data) && !COMPOSITE_PK_MODELS.has(model as string)) {
                    (args.data as any).forEach((item: any) => {
                        if (!item.id) item.id = nanoid(8);
                    });
                }
                return query(args);
            }
        }
    }
});

export default prisma;