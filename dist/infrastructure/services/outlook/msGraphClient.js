"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.graphFetch = exports.getAccessToken = exports.GraphRequestError = void 0;
/*
 * ⚠ NICHT IN BENUTZUNG (Stand 18.08.2026).
 *
 * Diese Datei gehoert zur Microsoft-365-/Graph-Anbindung. Sie ist bewusst
 * abgeklemmt: Mail geht ueber den EIGENEN Mailserver des Betriebs (SMTP per
 * nodemailer hinaus, IMAP per ImapCaptureService herein), weil das Postfach in
 * Outlook Online damit nicht abgeglichen ist. Der Code bleibt liegen, falls ein
 * Mandant spaeter doch auf Microsoft 365 laeuft — dann werden die Routen wieder
 * eingehaengt. Nichts importiert ihn zurzeit.
 */
const prisma_client_1 = __importDefault(require("../../database/prisma.client"));
const mailCrypto_1 = require("./mailCrypto");
const msGraphAuth_1 = require("./msGraphAuth");
class GraphRequestError extends Error {
    status;
    code;
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
exports.GraphRequestError = GraphRequestError;
const REFRESH_LEEWAY_MS = 5 * 60_000;
const inflightRefresh = new Map();
const loadAccount = async (accountId) => {
    const row = await prisma_client_1.default.mailAccount.findUnique({
        where: { id: accountId },
        select: { id: true, tenantId: true, refreshToken: true, accessToken: true, accessTokenExpiresAt: true },
    });
    if (!row)
        throw new msGraphAuth_1.MsAuthError("Mail-Konto nicht gefunden.", "account_missing", true);
    return {
        id: row.id,
        tenantId: row.tenantId,
        refreshToken: (0, mailCrypto_1.decryptSecret)(row.refreshToken) || "",
        accessToken: (0, mailCrypto_1.decryptSecret)(row.accessToken),
        accessTokenExpiresAt: row.accessTokenExpiresAt,
    };
};
const markNeedsReauth = async (accountId, message) => {
    await prisma_client_1.default.mailAccount.update({
        where: { id: accountId },
        data: { status: "NEEDS_REAUTH", lastError: message.slice(0, 1000), accessToken: null, accessTokenExpiresAt: null },
    }).catch(() => undefined);
};
/** Frisches Access-Token; Parallelaufrufe teilen sich EINEN Refresh. */
const getAccessToken = async (accountId, forceRefresh = false) => {
    const account = await loadAccount(accountId);
    const fresh = account.accessToken
        && account.accessTokenExpiresAt
        && account.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_LEEWAY_MS;
    if (fresh && !forceRefresh)
        return account.accessToken;
    const running = inflightRefresh.get(accountId);
    if (running)
        return running;
    const job = (async () => {
        try {
            const config = await (0, msGraphAuth_1.resolveMsAppConfig)(account.tenantId);
            if (!config)
                throw new msGraphAuth_1.MsAuthError("Microsoft-App-Registrierung fehlt.", "config_missing", true);
            if (!account.refreshToken)
                throw new msGraphAuth_1.MsAuthError("Kein Refresh-Token hinterlegt.", "no_refresh_token", true);
            const token = await (0, msGraphAuth_1.refreshAccessToken)(config, account.refreshToken);
            const expiresAt = new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000);
            await prisma_client_1.default.mailAccount.update({
                where: { id: accountId },
                data: {
                    accessToken: (0, mailCrypto_1.encryptSecret)(token.access_token),
                    accessTokenExpiresAt: expiresAt,
                    // Microsoft rotiert Refresh-Tokens: das neue ersetzt das alte.
                    ...(token.refresh_token ? { refreshToken: (0, mailCrypto_1.encryptSecret)(token.refresh_token) } : {}),
                    status: "ACTIVE",
                    lastError: null,
                },
            });
            return token.access_token;
        }
        catch (error) {
            if (error instanceof msGraphAuth_1.MsAuthError && error.needsReauth) {
                await markNeedsReauth(accountId, error.message);
            }
            throw error;
        }
        finally {
            inflightRefresh.delete(accountId);
        }
    })();
    inflightRefresh.set(accountId, job);
    return job;
};
exports.getAccessToken = getAccessToken;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * `path` ist entweder relativ (`/me/messages`) oder eine absolute URL
 * (`@odata.nextLink` / `@odata.deltaLink`).
 */
const graphFetch = async (accountId, path, options = {}) => {
    const url = /^https?:/i.test(path) ? path : `${msGraphAuth_1.GRAPH_BASE}${path}`;
    let token = await (0, exports.getAccessToken)(accountId);
    let attempt = 0;
    // Höchstens 4 Versuche: 401 (Token gerade abgelaufen) → einmal erneuern;
    // 429/503 → Retry-After (gedeckelt) abwarten.
    while (true) {
        attempt += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
        let response;
        try {
            response = await fetch(url, {
                method: options.method || "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    ...(options.body && !options.headers?.["Content-Type"] ? { "Content-Type": "application/json" } : {}),
                    ...(options.headers || {}),
                },
                body: options.body,
                signal: controller.signal,
            });
        }
        catch (error) {
            clearTimeout(timer);
            if (attempt < 3 && error?.name === "AbortError")
                continue;
            throw new GraphRequestError(`Microsoft Graph nicht erreichbar: ${error?.message || error}`, 0, "network");
        }
        clearTimeout(timer);
        if (response.status === 401 && attempt === 1) {
            token = await (0, exports.getAccessToken)(accountId, true);
            continue;
        }
        if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < 4) {
            const retryAfter = Number(response.headers.get("retry-after") || 0);
            await sleep(Math.min(Math.max(retryAfter, 1), 20) * 1000);
            continue;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            let code;
            let message = text.slice(0, 500);
            try {
                const json = JSON.parse(text);
                code = json?.error?.code;
                message = json?.error?.message || message;
            }
            catch { /* kein JSON */ }
            throw new GraphRequestError(`Graph ${response.status}${code ? ` ${code}` : ""}: ${message}`, response.status, code);
        }
        if (response.status === 202 || response.status === 204)
            return undefined;
        if (options.raw)
            return Buffer.from(await response.arrayBuffer());
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined);
    }
};
exports.graphFetch = graphFetch;
//# sourceMappingURL=msGraphClient.js.map