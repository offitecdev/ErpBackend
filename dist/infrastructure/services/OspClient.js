"use strict";
/**
 * ── OSP-CLIENT (Offitec Selection Platform, ausgehende Seite) ────────────────
 * Server-zu-Server-Aufrufe an das OSP-Backend (offer-integration-api.md §2–§4):
 * Statusmeldungen (`POST /integration/offer-status`) und das Zurücklesen
 * (`GET /integration/offer-status/{reference}`). Authentifiziert wird mit dem
 * gemeinsamen Schlüssel im Kopf `X-OSP-Integration-Key` — nie mit dem JWT.
 *
 * Alles hier ist BEST-EFFORT: eine nicht erreichbare OSP darf keinen
 * Speichervorgang bei uns scheitern lassen. Der Aufrufer bekommt {ok, error}
 * und schreibt beides an die Dokumentzeile (lastReport*).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchOspOfferStatus = exports.reportOspOfferStatus = exports.OSP_STATUS_RANK = exports.OSP_ENUM_TO_INTERNAL = exports.OSP_WIRE_STATUS = void 0;
/** Interne Stände → OSP-Statusform auf der Leitung (§3). */
exports.OSP_WIRE_STATUS = {
    LISTED: 'created',
    IN_OFFER: 'under review',
    SENT: 'offer has been sent',
};
/** OSP-Enum (Antworten) → unser interner Stand. APPROVED bleibt intern. */
exports.OSP_ENUM_TO_INTERNAL = {
    CREATED: 'LISTED',
    UNDER_REVIEW: 'IN_OFFER',
    OFFER_SENT: 'SENT',
};
/** Reihenfolge der Stände — die Abgleichung bewegt sich nur VORWÄRTS. */
exports.OSP_STATUS_RANK = {
    LISTED: 0,
    IN_OFFER: 1,
    SENT: 2,
    APPROVED: 3,
};
const OSP_TIMEOUT_MS = 8000;
const endpointReady = (endpoint) => Boolean((endpoint.ospBaseUrl || '').trim() && (endpoint.ospApiKey || '').trim());
const baseUrl = (endpoint) => (endpoint.ospBaseUrl || '').trim().replace(/\/+$/, '');
/**
 * Einen Bearbeitungsstand an die OSP melden. `salesmanEmail` ist bei
 * "under review" und "offer has been sent" Pflicht (OSP antwortet sonst 400) —
 * die Prüfung dazu macht der Aufrufer, hier wird nur übertragen.
 */
const reportOspOfferStatus = async (endpoint, reference, wireStatus, salesmanEmail) => {
    if (!endpointReady(endpoint))
        return { ok: false, skipped: true };
    try {
        const response = await fetch(`${baseUrl(endpoint)}/integration/offer-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-OSP-Integration-Key': (endpoint.ospApiKey || '').trim(),
            },
            body: JSON.stringify({
                projectNumber: reference,
                status: wireStatus,
                ...(salesmanEmail ? { salesmanEmail } : {}),
            }),
            signal: AbortSignal.timeout(OSP_TIMEOUT_MS),
        });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { ok: false, error: `OSP ${response.status}: ${message.slice(0, 300)}` };
        }
        const rows = (await response.json().catch(() => []));
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    }
    catch (error) {
        return { ok: false, error: error?.message || 'OSP nicht erreichbar.' };
    }
};
exports.reportOspOfferStatus = reportOspOfferStatus;
/**
 * Den Stand eines Belegs (oder ALLER Belege eines Projekts, bei nackter
 * Projektnummer) zurücklesen — zum Abgleich statt blinder Wiederholung (§4).
 */
const fetchOspOfferStatus = async (endpoint, reference) => {
    if (!endpointReady(endpoint))
        return { ok: false, skipped: true };
    try {
        const response = await fetch(`${baseUrl(endpoint)}/integration/offer-status/${encodeURIComponent(reference)}`, {
            headers: { 'X-OSP-Integration-Key': (endpoint.ospApiKey || '').trim() },
            signal: AbortSignal.timeout(OSP_TIMEOUT_MS),
        });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { ok: false, error: `OSP ${response.status}: ${message.slice(0, 300)}` };
        }
        const rows = (await response.json().catch(() => []));
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    }
    catch (error) {
        return { ok: false, error: error?.message || 'OSP nicht erreichbar.' };
    }
};
exports.fetchOspOfferStatus = fetchOspOfferStatus;
//# sourceMappingURL=OspClient.js.map