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
import { decryptSecret } from "./mailCrypto";

/**
 * Microsoft-Identity-Platform (v2.0) für die Outlook-/Microsoft-365-Anbindung.
 *
 * Es gibt EINE App-Registrierung pro Mandant (oder serverweit per Umgebung);
 * jeder Mitarbeitende verbindet damit sein EIGENES Postfach (delegierte
 * Berechtigungen, Authorization-Code-Flow). Der Server hält das Client-Secret
 * und die Refresh-Tokens; das Frontend sieht nur die Autorisierungs-URL und
 * reicht den `code` durch (`/mail/ms/callback`).
 */
// Beide Basis-URLs sind nur für Tests (Fake-Graph) überschreibbar.
export const GRAPH_BASE = (process.env.OFFITEC_MS_GRAPH_BASE || "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
const LOGIN_BASE = (process.env.OFFITEC_MS_LOGIN_BASE || "https://login.microsoftonline.com").replace(/\/$/, "");

/** Delegierte Rechte: Postfach lesen, senden, Profil, Refresh-Token. */
export const GRAPH_SCOPES = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "https://graph.microsoft.com/User.Read",
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Mail.Send",
];

export interface MsAppConfig {
    clientId: string;
    clientSecret: string;
    /** Azure-Mandant: GUID, Domain, `organizations` oder `common`. */
    authority: string;
    source: "TENANT" | "ENV";
}

const envConfig = (): MsAppConfig | null => {
    const clientId = (process.env.OFFITEC_MS_CLIENT_ID || "").trim();
    const clientSecret = (process.env.OFFITEC_MS_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) return null;
    return {
        clientId,
        clientSecret,
        authority: (process.env.OFFITEC_MS_TENANT || "common").trim() || "common",
        source: "ENV",
    };
};

/**
 * Konfiguration des Mandanten (Mail-Einstellungen) schlägt die Umgebung.
 * `null` = Anbindung nicht eingerichtet — die UI zeigt dann den Hinweis
 * "App-Registrierung fehlt" statt eines Verbinden-Knopfs.
 */
export const resolveMsAppConfig = async (tenantId: string): Promise<MsAppConfig | null> => {
    const setting = await prisma.mailSetting.findUnique({
        where: { tenantId },
        select: { msClientId: true, msClientSecret: true, msTenantId: true },
    });
    const clientId = (setting?.msClientId || "").trim();
    const clientSecret = decryptSecret(setting?.msClientSecret) || "";
    if (clientId && clientSecret) {
        return {
            clientId,
            clientSecret,
            authority: (setting?.msTenantId || "").trim() || "common",
            source: "TENANT",
        };
    }
    return envConfig();
};

export const buildAuthorizeUrl = (config: MsAppConfig, redirectUri: string, state: string, loginHint?: string | null): string => {
    const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: GRAPH_SCOPES.join(" "),
        state,
        prompt: "select_account",
    });
    if (loginHint) params.set("login_hint", loginHint);
    return `${LOGIN_BASE}/${encodeURIComponent(config.authority)}/oauth2/v2.0/authorize?${params.toString()}`;
};

export interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
    token_type: string;
}

export class MsAuthError extends Error {
    constructor(message: string, public readonly code: string, public readonly needsReauth = false) {
        super(message);
    }
}

const tokenRequest = async (config: MsAppConfig, form: Record<string, string>): Promise<TokenResponse> => {
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: GRAPH_SCOPES.join(" "),
        ...form,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
        response = await fetch(`${LOGIN_BASE}/${encodeURIComponent(config.authority)}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            signal: controller.signal,
        });
    } catch (error: any) {
        throw new MsAuthError(`Microsoft-Anmeldedienst nicht erreichbar: ${error?.message || error}`, "network");
    } finally {
        clearTimeout(timer);
    }
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
        const code = String(json?.error || `http_${response.status}`);
        // invalid_grant = Refresh-Token abgelaufen/widerrufen/Passwort geändert →
        // der Benutzer muss sich neu verbinden. Alles andere ist vorübergehend
        // oder ein Konfigurationsfehler (falsches Secret usw.).
        const needsReauth = code === "invalid_grant" || code === "interaction_required";
        const description = (String(json?.error_description || "").split("\n")[0] || "").slice(0, 300);
        throw new MsAuthError(`${code}${description ? `: ${description}` : ""}`, code, needsReauth);
    }
    return json as TokenResponse;
};

export const exchangeAuthCode = (config: MsAppConfig, code: string, redirectUri: string) =>
    tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refreshAccessToken = (config: MsAppConfig, refreshToken: string) =>
    tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
