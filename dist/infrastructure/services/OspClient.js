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
exports.fetchOspOfferStatus = exports.withdrawOspOfferStatus = exports.reportOspOfferStatus = exports.OSP_STATUS_RANK = exports.OSP_ENUM_TO_INTERNAL = exports.OSP_WIRE_STATUS = void 0;
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
 * `fetch` wirft bei JEDEM Netzfehler dasselbe nackte "fetch failed" — der
 * eigentliche Grund (falscher Rechnername, Zeitüberschreitung, Zertifikat)
 * steckt in `cause`. Ohne diesen Zusatz steht an der Zeile ein Fehler, mit dem
 * niemand etwas anfangen kann; deshalb wird die Ursache mit ausgewiesen — samt
 * der Adresse, die versucht wurde.
 */
const describeFetchFailure = (error, url) => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return `OSP antwortet nicht (${OSP_TIMEOUT_MS} ms überschritten): ${url}`;
    }
    const cause = error?.cause;
    const code = cause?.code || error?.code;
    const detail = [code, cause?.message].filter(Boolean).join(' — ');
    const reason = code === 'ENOTFOUND'
        ? 'Basisadresse unbekannt (DNS)'
        : code === 'ECONNREFUSED'
            ? 'Verbindung abgewiesen'
            : detail || error?.message || 'OSP nicht erreichbar.';
    return `${reason}: ${url}`;
};
/**
 * Die §3-Visitenkarte auf der Leitung. Nur `email` trägt für sich Gewicht;
 * alles andere ist freiwillig und wird weggelassen, wenn es leer ist —
 * Fehlendes füllt die OSP aus dem eigenen Konto, sofern es die Adresse kennt.
 */
const salesmanBody = (salesman) => {
    const email = (salesman?.email || '').trim();
    if (!email)
        return {};
    const parts = {};
    for (const [key, value] of Object.entries({
        name: salesman?.name,
        surname: salesman?.surname,
        phone: salesman?.phone,
        imageUrl: salesman?.imageUrl,
    })) {
        const trimmed = (value || '').trim();
        if (trimmed)
            parts[key] = trimmed;
    }
    // Ohne einen einzigen weiteren Wert bleibt die flache Form: ein Objekt,
    // das nur eine Adresse enthält, sagt nichts, was `salesmanEmail` nicht
    // schon sagt — und ein leeres `salesman` würde drüben die abgelegte
    // Visitenkarte durch nichts ersetzen.
    if (!Object.keys(parts).length)
        return { salesmanEmail: email };
    return { salesman: { email, ...parts } };
};
/**
 * Einen Bearbeitungsstand an die OSP melden. Die Adresse der zuständigen
 * Person ist bei "under review" und "offer has been sent" Pflicht (OSP
 * antwortet sonst 400) — die Prüfung dazu macht der Aufrufer, hier wird nur
 * übertragen.
 *
 * Mitgeschickt wird die ganze Visitenkarte (§3 "salesman"): hat die Adresse
 * drüben KEIN OSP-Konto, sieht die anfragende Person dann trotzdem Name und
 * Rufnummer statt einer nackten E-Mail-Adresse. Und mitgeschickt wird sie bei
 * JEDER Meldung — eine Meldung, die nur eine Adresse trägt, ersetzt drüben die
 * abgelegte Karte, sodass nach einem Wechsel sonst der alte Name stehen bliebe.
 */
const reportOspOfferStatus = async (endpoint, reference, wireStatus, salesman) => {
    if (!endpointReady(endpoint))
        return { ok: false, skipped: true };
    const url = `${baseUrl(endpoint)}/integration/offer-status`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-OSP-Integration-Key': (endpoint.ospApiKey || '').trim(),
            },
            body: JSON.stringify({
                projectNumber: reference,
                status: wireStatus,
                ...salesmanBody(salesman),
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
        return { ok: false, error: describeFetchFailure(error, url) };
    }
};
exports.reportOspOfferStatus = reportOspOfferStatus;
/**
 * Eine Offertanfrage bei der OSP ZURÜCKZIEHEN (§4b):
 * DELETE /integration/offer-status/{reference}. Drüben wird nichts gelöscht —
 * nur Status und Zuständigkeit werden geleert, die Karte zeigt wieder "keine
 * Offerte" und die Kundschaft darf neu anfragen. Idempotent: ein Verweis ohne
 * laufende Anfrage antwortet 200 mit unverändertem Stand.
 */
const withdrawOspOfferStatus = async (endpoint, reference) => {
    if (!endpointReady(endpoint))
        return { ok: false, skipped: true };
    const url = `${baseUrl(endpoint)}/integration/offer-status/${encodeURIComponent(reference)}`;
    try {
        const response = await fetch(url, {
            method: 'DELETE',
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
        return { ok: false, error: describeFetchFailure(error, url) };
    }
};
exports.withdrawOspOfferStatus = withdrawOspOfferStatus;
/**
 * Den Stand eines Belegs (oder ALLER Belege eines Projekts, bei nackter
 * Projektnummer) zurücklesen — zum Abgleich statt blinder Wiederholung (§4).
 */
const fetchOspOfferStatus = async (endpoint, reference) => {
    if (!endpointReady(endpoint))
        return { ok: false, skipped: true };
    const url = `${baseUrl(endpoint)}/integration/offer-status/${encodeURIComponent(reference)}`;
    try {
        const response = await fetch(url, {
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
        return { ok: false, error: describeFetchFailure(error, url) };
    }
};
exports.fetchOspOfferStatus = fetchOspOfferStatus;
//# sourceMappingURL=OspClient.js.map