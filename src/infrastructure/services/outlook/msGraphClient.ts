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
import prisma from "../../database/prisma.client";
import { decryptSecret, encryptSecret } from "./mailCrypto";
import { GRAPH_BASE, MsAuthError, refreshAccessToken, resolveMsAppConfig } from "./msGraphAuth";

/**
 * Dünner Graph-Client rund um ein `MailAccount`: besorgt ein gültiges
 * Access-Token (Refresh-Token → neues Token, ~5 Minuten Vorlauf), wiederholt
 * einmal bei 401, wartet bei 429/503 gemäss `Retry-After`. Fehlerhafte
 * Refreshes (`invalid_grant`) setzen das Konto auf NEEDS_REAUTH, damit die
 * Sync-Schleife es nicht in Endlosschleife hämmert und die UI "neu verbinden"
 * anbieten kann.
 */
export interface GraphAccount {
    id: string;
    tenantId: string;
    refreshToken: string;
    accessToken: string | null;
    accessTokenExpiresAt: Date | null;
}

export class GraphRequestError extends Error {
    constructor(message: string, public readonly status: number, public readonly code?: string) {
        super(message);
    }
}

const REFRESH_LEEWAY_MS = 5 * 60_000;
const inflightRefresh = new Map<string, Promise<string>>();

const loadAccount = async (accountId: string): Promise<GraphAccount> => {
    const row = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { id: true, tenantId: true, refreshToken: true, accessToken: true, accessTokenExpiresAt: true },
    });
    if (!row) throw new MsAuthError("Mail-Konto nicht gefunden.", "account_missing", true);
    return {
        id: row.id,
        tenantId: row.tenantId,
        refreshToken: decryptSecret(row.refreshToken) || "",
        accessToken: decryptSecret(row.accessToken),
        accessTokenExpiresAt: row.accessTokenExpiresAt,
    };
};

const markNeedsReauth = async (accountId: string, message: string) => {
    await prisma.mailAccount.update({
        where: { id: accountId },
        data: { status: "NEEDS_REAUTH", lastError: message.slice(0, 1000), accessToken: null, accessTokenExpiresAt: null },
    }).catch(() => undefined);
};

/** Frisches Access-Token; Parallelaufrufe teilen sich EINEN Refresh. */
export const getAccessToken = async (accountId: string, forceRefresh = false): Promise<string> => {
    const account = await loadAccount(accountId);
    const fresh = account.accessToken
        && account.accessTokenExpiresAt
        && account.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_LEEWAY_MS;
    if (fresh && !forceRefresh) return account.accessToken!;

    const running = inflightRefresh.get(accountId);
    if (running) return running;
    const job = (async () => {
        try {
            const config = await resolveMsAppConfig(account.tenantId);
            if (!config) throw new MsAuthError("Microsoft-App-Registrierung fehlt.", "config_missing", true);
            if (!account.refreshToken) throw new MsAuthError("Kein Refresh-Token hinterlegt.", "no_refresh_token", true);
            const token = await refreshAccessToken(config, account.refreshToken);
            const expiresAt = new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000);
            await prisma.mailAccount.update({
                where: { id: accountId },
                data: {
                    accessToken: encryptSecret(token.access_token),
                    accessTokenExpiresAt: expiresAt,
                    // Microsoft rotiert Refresh-Tokens: das neue ersetzt das alte.
                    ...(token.refresh_token ? { refreshToken: encryptSecret(token.refresh_token) } : {}),
                    status: "ACTIVE",
                    lastError: null,
                },
            });
            return token.access_token;
        } catch (error: any) {
            if (error instanceof MsAuthError && error.needsReauth) {
                await markNeedsReauth(accountId, error.message);
            }
            throw error;
        } finally {
            inflightRefresh.delete(accountId);
        }
    })();
    inflightRefresh.set(accountId, job);
    return job;
};

export interface GraphFetchOptions {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: string | Buffer;
    headers?: Record<string, string>;
    /** Antwort als Buffer statt JSON (Anhänge). */
    raw?: boolean;
    timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `path` ist entweder relativ (`/me/messages`) oder eine absolute URL
 * (`@odata.nextLink` / `@odata.deltaLink`).
 */
export const graphFetch = async <T = any>(accountId: string, path: string, options: GraphFetchOptions = {}): Promise<T> => {
    const url = /^https?:/i.test(path) ? path : `${GRAPH_BASE}${path}`;
    let token = await getAccessToken(accountId);
    let attempt = 0;
    // Höchstens 4 Versuche: 401 (Token gerade abgelaufen) → einmal erneuern;
    // 429/503 → Retry-After (gedeckelt) abwarten.
    while (true) {
        attempt += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
        let response: Response;
        try {
            response = await fetch(url, {
                method: options.method || "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    ...(options.body && !options.headers?.["Content-Type"] ? { "Content-Type": "application/json" } : {}),
                    ...(options.headers || {}),
                },
                body: options.body as any,
                signal: controller.signal,
            });
        } catch (error: any) {
            clearTimeout(timer);
            if (attempt < 3 && error?.name === "AbortError") continue;
            throw new GraphRequestError(`Microsoft Graph nicht erreichbar: ${error?.message || error}`, 0, "network");
        }
        clearTimeout(timer);

        if (response.status === 401 && attempt === 1) {
            token = await getAccessToken(accountId, true);
            continue;
        }
        if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < 4) {
            const retryAfter = Number(response.headers.get("retry-after") || 0);
            await sleep(Math.min(Math.max(retryAfter, 1), 20) * 1000);
            continue;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            let code: string | undefined;
            let message = text.slice(0, 500);
            try {
                const json = JSON.parse(text);
                code = json?.error?.code;
                message = json?.error?.message || message;
            } catch { /* kein JSON */ }
            throw new GraphRequestError(`Graph ${response.status}${code ? ` ${code}` : ""}: ${message}`, response.status, code);
        }
        if (response.status === 202 || response.status === 204) return undefined as T;
        if (options.raw) return Buffer.from(await response.arrayBuffer()) as unknown as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }
};
