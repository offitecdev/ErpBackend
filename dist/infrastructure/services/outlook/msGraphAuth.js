"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshAccessToken = exports.exchangeAuthCode = exports.MsAuthError = exports.buildAuthorizeUrl = exports.resolveMsAppConfig = exports.GRAPH_SCOPES = exports.GRAPH_BASE = void 0;
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
const serviceTenantScope_1 = require("../../../presentation/controllers/serviceTenantScope");
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
exports.GRAPH_BASE = (process.env.OFFITEC_MS_GRAPH_BASE || "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
const LOGIN_BASE = (process.env.OFFITEC_MS_LOGIN_BASE || "https://login.microsoftonline.com").replace(/\/$/, "");
/** Delegierte Rechte: Postfach lesen, senden, Profil, Refresh-Token. */
exports.GRAPH_SCOPES = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "https://graph.microsoft.com/User.Read",
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Mail.Send",
];
const envConfig = () => {
    const clientId = (process.env.OFFITEC_MS_CLIENT_ID || "").trim();
    const clientSecret = (process.env.OFFITEC_MS_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret)
        return null;
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
const resolveMsAppConfig = async (selectedTenantId) => {
    // Die App-Registrierung gehört zum Firmenpostfach — und das hängt am Stamm.
    const setting = await prisma_client_1.default.mailSetting.findUnique({
        where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId) },
        select: { msClientId: true, msClientSecret: true, msTenantId: true },
    });
    const clientId = (setting?.msClientId || "").trim();
    const clientSecret = (0, mailCrypto_1.decryptSecret)(setting?.msClientSecret) || "";
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
exports.resolveMsAppConfig = resolveMsAppConfig;
const buildAuthorizeUrl = (config, redirectUri, state, loginHint) => {
    const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: exports.GRAPH_SCOPES.join(" "),
        state,
        prompt: "select_account",
    });
    if (loginHint)
        params.set("login_hint", loginHint);
    return `${LOGIN_BASE}/${encodeURIComponent(config.authority)}/oauth2/v2.0/authorize?${params.toString()}`;
};
exports.buildAuthorizeUrl = buildAuthorizeUrl;
class MsAuthError extends Error {
    code;
    needsReauth;
    constructor(message, code, needsReauth = false) {
        super(message);
        this.code = code;
        this.needsReauth = needsReauth;
    }
}
exports.MsAuthError = MsAuthError;
const tokenRequest = async (config, form) => {
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: exports.GRAPH_SCOPES.join(" "),
        ...form,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response;
    try {
        response = await fetch(`${LOGIN_BASE}/${encodeURIComponent(config.authority)}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            signal: controller.signal,
        });
    }
    catch (error) {
        throw new MsAuthError(`Microsoft-Anmeldedienst nicht erreichbar: ${error?.message || error}`, "network");
    }
    finally {
        clearTimeout(timer);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        const code = String(json?.error || `http_${response.status}`);
        // invalid_grant = Refresh-Token abgelaufen/widerrufen/Passwort geändert →
        // der Benutzer muss sich neu verbinden. Alles andere ist vorübergehend
        // oder ein Konfigurationsfehler (falsches Secret usw.).
        const needsReauth = code === "invalid_grant" || code === "interaction_required";
        const description = (String(json?.error_description || "").split("\n")[0] || "").slice(0, 300);
        throw new MsAuthError(`${code}${description ? `: ${description}` : ""}`, code, needsReauth);
    }
    return json;
};
const exchangeAuthCode = (config, code, redirectUri) => tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
exports.exchangeAuthCode = exchangeAuthCode;
const refreshAccessToken = (config, refreshToken) => tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
exports.refreshAccessToken = refreshAccessToken;
//# sourceMappingURL=msGraphAuth.js.map