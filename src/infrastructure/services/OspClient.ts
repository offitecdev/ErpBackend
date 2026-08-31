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
    /** 404: die OSP kennt diesen Beleg gar nicht. Für einen RÜCKZUG ist das
        kein Fehler, sondern das Ziel — drüben steht schon nichts mehr. */
    notFound?: boolean;
    error?: string;
    rows?: OspStatusRow[];
}

const OSP_TIMEOUT_MS = 8000;

const endpointReady = (endpoint: OspEndpoint): boolean =>
    Boolean((endpoint.ospBaseUrl || '').trim() && (endpoint.ospApiKey || '').trim());

const baseUrl = (endpoint: OspEndpoint): string => (endpoint.ospBaseUrl || '').trim().replace(/\/+$/, '');

/**
 * `fetch` wirft bei JEDEM Netzfehler dasselbe nackte "fetch failed" — der
 * eigentliche Grund (falscher Rechnername, Zeitüberschreitung, Zertifikat)
 * steckt in `cause`. Ohne diesen Zusatz steht an der Zeile ein Fehler, mit dem
 * niemand etwas anfangen kann; deshalb wird die Ursache mit ausgewiesen — samt
 * der Adresse, die versucht wurde.
 */
const describeFetchFailure = (error: any, url: string): string => {
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
const salesmanBody = (salesman: OspSalesmanDto | null | undefined): Record<string, unknown> => {
    const email = (salesman?.email || '').trim();
    if (!email) return {};
    const parts: Record<string, string> = {};
    for (const [key, value] of Object.entries({
        name: salesman?.name,
        surname: salesman?.surname,
        phone: salesman?.phone,
        imageUrl: salesman?.imageUrl,
    })) {
        const trimmed = (value || '').trim();
        if (trimmed) parts[key] = trimmed;
    }
    // Ohne einen einzigen weiteren Wert bleibt die flache Form: ein Objekt,
    // das nur eine Adresse enthält, sagt nichts, was `salesmanEmail` nicht
    // schon sagt — und ein leeres `salesman` würde drüben die abgelegte
    // Visitenkarte durch nichts ersetzen.
    if (!Object.keys(parts).length) return { salesmanEmail: email };
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
export const reportOspOfferStatus = async (
    endpoint: OspEndpoint,
    reference: string,
    wireStatus: string,
    salesman?: OspSalesmanDto | null,
): Promise<OspCallResult> => {
    if (!endpointReady(endpoint)) return { ok: false, skipped: true };
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
        const rows = (await response.json().catch(() => [])) as OspStatusRow[];
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch (error: any) {
        return { ok: false, error: describeFetchFailure(error, url) };
    }
};

/**
 * Eine Offertanfrage bei der OSP ZURÜCKZIEHEN (§4b):
 * DELETE /integration/offer-status/{reference}. Drüben wird nichts gelöscht —
 * nur Status und Zuständigkeit werden geleert, die Karte zeigt wieder "keine
 * Offerte" und die Kundschaft darf neu anfragen. Idempotent: ein Verweis ohne
 * laufende Anfrage antwortet 200 mit unverändertem Stand.
 */
export const withdrawOspOfferStatus = async (
    endpoint: OspEndpoint,
    reference: string,
): Promise<OspCallResult> => {
    if (!endpointReady(endpoint)) return { ok: false, skipped: true };
    const url = `${baseUrl(endpoint)}/integration/offer-status/${encodeURIComponent(reference)}`;
    try {
        const response = await fetch(url, {
            method: 'DELETE',
            headers: { 'X-OSP-Integration-Key': (endpoint.ospApiKey || '').trim() },
            signal: AbortSignal.timeout(OSP_TIMEOUT_MS),
        });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return {
                ok: false,
                // Ein Beleg, den die OSP nicht kennt, kann drüben auch nichts
                // mehr tragen — der Rückzug hat sein Ziel dann schon erreicht.
                notFound: response.status === 404,
                error: `OSP ${response.status}: ${message.slice(0, 300)}`,
            };
        }
        const rows = (await response.json().catch(() => [])) as OspStatusRow[];
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch (error: any) {
        return { ok: false, error: describeFetchFailure(error, url) };
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
    const url = `${baseUrl(endpoint)}/integration/offer-status/${encodeURIComponent(reference)}`;
    try {
        const response = await fetch(
            url,
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
        return { ok: false, error: describeFetchFailure(error, url) };
    }
};
