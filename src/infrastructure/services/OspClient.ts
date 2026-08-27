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

/** Interne Stände → OSP-Statusform auf der Leitung (§3). */
export const OSP_WIRE_STATUS: Record<string, string> = {
    LISTED: 'created',
    IN_OFFER: 'under review',
    SENT: 'offer has been sent',
};

/** OSP-Enum (Antworten) → unser interner Stand. APPROVED bleibt intern. */
export const OSP_ENUM_TO_INTERNAL: Record<string, string> = {
    CREATED: 'LISTED',
    UNDER_REVIEW: 'IN_OFFER',
    OFFER_SENT: 'SENT',
};

/** Reihenfolge der Stände — die Abgleichung bewegt sich nur VORWÄRTS. */
export const OSP_STATUS_RANK: Record<string, number> = {
    LISTED: 0,
    IN_OFFER: 1,
    SENT: 2,
    APPROVED: 3,
};

export interface OspEndpoint {
    ospBaseUrl?: string | null;
    ospApiKey?: string | null;
}

export interface OspSalesmanDto {
    email?: string | null;
    name?: string | null;
    surname?: string | null;
    imageUrl?: string | null;
    phone?: string | null;
}

export interface OspStatusRow {
    reference: string;
    status: string;
    updatedAt?: string;
    salesman?: OspSalesmanDto | null;
}

export interface OspCallResult {
    ok: boolean;
    /** true, wenn gar keine Basisadresse/kein Schlüssel hinterlegt ist —
        dann ist "nichts melden" gewollt und KEIN Fehler. */
    skipped?: boolean;
    error?: string;
    rows?: OspStatusRow[];
}

const OSP_TIMEOUT_MS = 8000;

const endpointReady = (endpoint: OspEndpoint): boolean =>
    Boolean((endpoint.ospBaseUrl || '').trim() && (endpoint.ospApiKey || '').trim());

const baseUrl = (endpoint: OspEndpoint): string => (endpoint.ospBaseUrl || '').trim().replace(/\/+$/, '');

/**
 * Einen Bearbeitungsstand an die OSP melden. `salesmanEmail` ist bei
 * "under review" und "offer has been sent" Pflicht (OSP antwortet sonst 400) —
 * die Prüfung dazu macht der Aufrufer, hier wird nur übertragen.
 */
export const reportOspOfferStatus = async (
    endpoint: OspEndpoint,
    reference: string,
    wireStatus: string,
    salesmanEmail?: string | null,
): Promise<OspCallResult> => {
    if (!endpointReady(endpoint)) return { ok: false, skipped: true };
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
        const rows = (await response.json().catch(() => [])) as OspStatusRow[];
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch (error: any) {
        return { ok: false, error: error?.message || 'OSP nicht erreichbar.' };
    }
};

/**
 * Den Stand eines Belegs (oder ALLER Belege eines Projekts, bei nackter
 * Projektnummer) zurücklesen — zum Abgleich statt blinder Wiederholung (§4).
 */
export const fetchOspOfferStatus = async (
    endpoint: OspEndpoint,
    reference: string,
): Promise<OspCallResult> => {
    if (!endpointReady(endpoint)) return { ok: false, skipped: true };
    try {
        const response = await fetch(
            `${baseUrl(endpoint)}/integration/offer-status/${encodeURIComponent(reference)}`,
            {
                headers: { 'X-OSP-Integration-Key': (endpoint.ospApiKey || '').trim() },
                signal: AbortSignal.timeout(OSP_TIMEOUT_MS),
            },
        );
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { ok: false, error: `OSP ${response.status}: ${message.slice(0, 300)}` };
        }
        const rows = (await response.json().catch(() => [])) as OspStatusRow[];
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch (error: any) {
        return { ok: false, error: error?.message || 'OSP nicht erreichbar.' };
    }
};
