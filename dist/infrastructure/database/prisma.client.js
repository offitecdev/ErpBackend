"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const adapter_mariadb_1 = require("@prisma/adapter-mariadb");
const crypto_1 = __importDefault(require("crypto"));
const nanoid_1 = require("nanoid");
function decryptDatabasePassword() {
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
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', key, iv);
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
// The database is remote, so every fresh connection pays a TCP + auth
// handshake worth several network round-trips. Keep a floor of idle
// connections open (and TCP-alive) so requests never pay that cost — the
// first save after a server start/idle period used to take seconds.
const adapter = new adapter_mariadb_1.PrismaMariaDb({
    host: dbHost,
    port: Number(dbPort),
    user: rawDbUser,
    password: rawDbPass,
    database: dbName,
    connectionLimit: 10,
    minimumIdle: 4,
    keepAliveDelay: 30_000,
});
// Models using composite primary keys (@@id) — these have no standalone `id` field
const COMPOSITE_PK_MODELS = new Set(['EmployeeRole', 'RolePermission']);
const prisma = new client_1.PrismaClient({
    adapter,
    errorFormat: 'pretty'
}).$extends({
    query: {
        $allModels: {
            async create({ model, args, query }) {
                const data = args.data;
                if (data && !data.id && !COMPOSITE_PK_MODELS.has(model)) {
                    data.id = (0, nanoid_1.nanoid)(8);
                }
                return query(args);
            },
            async createMany({ model, args, query }) {
                if (args.data && Array.isArray(args.data) && !COMPOSITE_PK_MODELS.has(model)) {
                    args.data.forEach((item) => {
                        if (!item.id)
                            item.id = (0, nanoid_1.nanoid)(8);
                    });
                }
                return query(args);
            }
        }
    }
});
exports.default = prisma;
//# sourceMappingURL=prisma.client.js.map