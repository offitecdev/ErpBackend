/* Nachweis der Korrekturen 10 (API-Dokumentation nicht öffentlich),
   11 (CSRF auf den Anmeldewegen), 12 (öffentliche Schlüssel nicht im Pfad,
   mit Frist und Bremse) und 13 (geprüfte Laufzeitumgebung).

   Der Lauf legt zwei eigene Unterschriftsaufträge an und räumt sie ab.
   Die Fälle, die eine ANDERE Umgebung brauchen (Produktivbetrieb,
   SameSite=none), werden an der echten Entscheidungsstelle geprüft — ein
   zweiter Server daneben würde den Lesestand des Postfachs verschieben. */
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { apiDocsAccess } from '../src/infrastructure/config/apiDocs';
import { assertRuntimeConfig, RuntimeConfigError } from '../src/infrastructure/config/runtime';
import { requireCsrfOnPublicAuth } from '../src/presentation/middlewares/CsrfMiddleware';
import { isSignatureLinkExpired, isBookingLinkExpired } from '../src/presentation/utils/publicToken';
import { redactPublicTokens } from '../src/presentation/utils/logRedaction';

const BASE = 'http://localhost:3000/api/v1';
const ROOT = 'http://localhost:3000';
const ok = (b: boolean) => (b ? 'OK  ' : 'FEHL');

let failures = 0;
const check = (passed: boolean, label: string) => {
    if (!passed) failures += 1;
    console.log(`${ok(passed)} ${label}`);
};

/** Ruft eine Middleware mit erfundenen Objekten auf und meldet die Antwort. */
const runMiddleware = (mw: any, req: any): { status: number | null; body: any } => {
    let status: number | null = null;
    let body: any = null;
    let passedThrough = false;
    const res = {
        status(code: number) { status = code; return this; },
        json(payload: any) { body = payload; return this; },
    };
    mw({ cookies: {}, header: () => undefined, ...req }, res, () => { passedThrough = true; });
    return { status: passedThrough ? null : status, body };
};

/** Umgebungsvariablen für einen Versuch setzen und danach zurückstellen. */
const withEnv = <T>(patch: Record<string, string | undefined>, run: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(patch)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return run();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const throwsRuntimeConfig = (patch: Record<string, string | undefined>): boolean =>
    withEnv(patch, () => {
        try { assertRuntimeConfig(); return false; } catch (e) { return e instanceof RuntimeConfigError; }
    });

(async () => {
    // ═══════════════ FIX 13 — die Umgebung wird geprüft, nicht geraten ═══════
    console.log('════ FIX 13 — OFFITEC_ENV hängt nicht mehr an einer ungeprüften Zeichenkette ════');

    check(throwsRuntimeConfig({ OFFITEC_ENV: undefined }), 'nicht gesetzt: der Dienst startet NICHT (früher: still "keine Secure-Kekse")');
    // Gross-/Kleinschreibung ist erlaubt — aber "Production" muss dann auch
    // WIRKLICH als Produktivbetrieb gelten. Beweis: mit einem unverschluesselten
    // Ursprung dazu muss derselbe Wert die Produktivpruefung ausloesen.
    check(!throwsRuntimeConfig({ OFFITEC_ENV: 'Production' }), '"Production" wird angenommen (Gross-/Kleinschreibung egal) ...');
    check(
        throwsRuntimeConfig({ OFFITEC_ENV: 'Production', OFFITEC_CORS_ORIGINS: 'http://kunde.example.com' }),
        '... und gilt dabei wirklich als Produktivbetrieb (die Produktivpruefung greift)',
    );
    check(throwsRuntimeConfig({ OFFITEC_ENV: 'prod' }), '"prod" wird abgewiesen (kein stilles Raten)');
    check(throwsRuntimeConfig({ OFFITEC_COOKIE_SAMESITE: 'nonee' }), 'unbekanntes SameSite wird abgewiesen (frueher: still auf lax zurueckgesetzt)');
    check(!throwsRuntimeConfig({ OFFITEC_COOKIE_SAMESITE: 'None' }), '"None" wird angenommen (Gross-/Kleinschreibung egal)');
    check(
        throwsRuntimeConfig({ OFFITEC_ENV: 'production', OFFITEC_CORS_ORIGINS: 'http://kunde.example.com' }),
        'Produktivbetrieb mit unverschluesseltem Ursprung startet NICHT',
    );
    check(
        !throwsRuntimeConfig({ OFFITEC_ENV: 'production', OFFITEC_CORS_ORIGINS: 'https://demo.offitec.ch,http://localhost:5173' }),
        'Produktivbetrieb ueber https startet (oertliche Adressen sind ausgenommen)',
    );
    check(!throwsRuntimeConfig({}), 'die aktuelle .env ist gueltig');

    // ═══════════════ FIX 10 — die Dokumentation ist nicht öffentlich ═════════
    console.log('\n════ FIX 10 — /api-docs und /swagger.json ════');

    check(apiDocsAccess('production', undefined).enabled === false, 'Produktivbetrieb ohne OFFITEC_API_DOCS: AUS (frueher: fuer jeden offen)');
    check(apiDocsAccess('production', '').enabled === false, 'Produktivbetrieb mit leerer Variable: AUS');
    check(apiDocsAccess('production', 'on').enabled === true, 'Produktivbetrieb mit OFFITEC_API_DOCS=on: AN ...');
    check(apiDocsAccess('production', 'on').requireLogin === true, '... aber nur mit gueltiger Sitzung');
    check(apiDocsAccess('development', undefined).enabled === true, 'Entwicklung: AN');
    check(apiDocsAccess('development', undefined).requireLogin === false, 'Entwicklung: ohne Anmeldung');
    check(apiDocsAccess('development', 'off').enabled === false, 'Entwicklung mit OFFITEC_API_DOCS=off: AUS');

    const docsRes = await fetch(`${ROOT}/api-docs/`);
    const docsCsp = docsRes.headers.get('content-security-policy');
    check(docsRes.status === 200, 'in der Entwicklung erreichbar (200)');
    check(Boolean(docsCsp), 'die Inhaltsrichtlinie wird NICHT mehr entfernt (frueher: removeHeader)');
    check((docsCsp || '').includes("script-src 'self'"), 'die Richtlinie greift (script-src self)');
    check((docsCsp || '').includes("frame-ancestors 'none'"), 'und verbietet das Einbetten');

    const initRes = await fetch(`${ROOT}/api-docs/swagger-ui-init.js`);
    check(initRes.status === 200, 'der Startcode kommt als eigene Datei — die Richtlinie bricht die Seite nicht');

    // ═══════════════ FIX 11 — CSRF auf den Anmeldewegen ══════════════════════
    console.log('\n════ FIX 11 — Anmeldung / Abmeldung / Erneuerung ════');

    const csrfRes = await fetch(`${BASE}/auth/csrf`);
    const csrfBody = await csrfRes.json() as { csrfToken?: string };
    const setCookie = csrfRes.headers.get('set-cookie') || '';
    check(csrfRes.status === 200 && Boolean(csrfBody.csrfToken), 'GET /auth/csrf liefert einen Wert VOR der Anmeldung');
    check(setCookie.includes('ofi_csrf='), '... und setzt ihn als Keks');
    check(setCookie.includes('HttpOnly') === false, '... lesbar fuer die Seite (Doppelvorlage braucht das)');

    // Unter Lax laesst die Pruefung durch — sonst sperrte sie Swagger und curl aus.
    const lax = runMiddleware(requireCsrfOnPublicAuth, {});
    check(lax.status === null, 'unter SameSite=Lax: durchgelassen (der Browser schickt fremd gar keinen Keks)');

    // Unter none ist sie der einzige Schutz und greift.
    withEnv({ OFFITEC_COOKIE_SAMESITE: 'none' }, () => {
        const ohne = runMiddleware(requireCsrfOnPublicAuth, {});
        check(ohne.status === 403, 'unter SameSite=none OHNE Wert: 403 (frueher: fremde Seite konnte abmelden/anmelden)');

        const falsch = runMiddleware(requireCsrfOnPublicAuth, {
            cookies: { ofi_csrf: 'aaa' },
            header: (name: string) => (name === 'x-csrf-token' ? 'bbb' : undefined),
        });
        check(falsch.status === 403, 'unter SameSite=none mit FALSCHEM Wert: 403');

        const richtig = runMiddleware(requireCsrfOnPublicAuth, {
            cookies: { ofi_csrf: 'aaa' },
            header: (name: string) => (name === 'x-csrf-token' ? 'aaa' : undefined),
        });
        check(richtig.status === null, 'unter SameSite=none mit passendem Wert: durchgelassen');
    });

    // Ueber die Schnittstelle: unter der heutigen Einstellung (Lax) unveraendert.
    const loginRes = await fetch(`${BASE}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@offitec.test', password: 'Falsch123!' }),
    });
    check(loginRes.status !== 403, `die Anmeldung laeuft unter Lax weiter ohne Kopf (${loginRes.status}, kein 403)`);

    // ═══════════════ FIX 12 — öffentliche Schlüssel ══════════════════════════
    console.log('\n════ FIX 12 — Unterschriftsverweis: Kopf statt Pfad, mit Frist und Bremse ════');

    check(isSignatureLinkExpired(new Date(Date.now() - 31 * 24 * 3600 * 1000)), 'Unterschriftsverweis nach 31 Tagen: abgelaufen (frueher: unbegrenzt)');
    check(!isSignatureLinkExpired(new Date(Date.now() - 29 * 24 * 3600 * 1000)), 'nach 29 Tagen: noch gueltig');
    check(isBookingLinkExpired(new Date(Date.now() - 8 * 24 * 3600 * 1000)), 'Terminverweis 8 Tage nach dem Termin: abgelaufen');
    check(!isBookingLinkExpired(new Date(Date.now() + 24 * 3600 * 1000)), 'Termin morgen: gueltig');

    const tenant = (await prisma.tenant.findFirst({ where: { isActive: true }, select: { id: true } }))!;
    const token = nanoid(32);
    const staleToken = nanoid(32);
    const fresh = await prisma.signatureRequest.create({
        data: {
            id: nanoid(), tenantId: tenant.id, reportType: 'GENERAL', token,
            title: 'Sicherheitspruefung', snapshot: {}, status: 'PENDING',
        },
        select: { id: true },
    });
    // Ein Auftrag, der vor 60 Tagen ausgestellt wurde.
    const stale = await prisma.signatureRequest.create({
        data: {
            id: nanoid(), tenantId: tenant.id, reportType: 'GENERAL', token: staleToken,
            title: 'Alter Verweis', snapshot: {}, status: 'PENDING',
            createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000),
        },
        select: { id: true },
    });

    try {
        const viaHeader = await fetch(`${BASE}/signature-requests/public`, {
            headers: { 'X-Public-Token': token },
        });
        check(viaHeader.status === 200, 'der Schluessel im KOPF oeffnet den Auftrag (200)');

        const viaPath = await fetch(`${BASE}/signature-requests/public/${token}`);
        check(viaPath.status === 200, 'der alte Weg im Pfad geht weiter (verschickte Verweise)');

        const ohneSchluessel = await fetch(`${BASE}/signature-requests/public`);
        check(ohneSchluessel.status === 404, 'ohne Schluessel: 404');

        const abgelaufen = await fetch(`${BASE}/signature-requests/public`, {
            headers: { 'X-Public-Token': staleToken },
        });
        const abgelaufenBody = await abgelaufen.json() as { error?: string };
        check(abgelaufen.status === 404, 'der 60 Tage alte Verweis: 404 (frueher: 200, fuer immer)');
        check(
            abgelaufenBody.error === 'Bağlantı geçersiz veya süresi dolmuş.',
            '... mit demselben Satz wie ein unbekannter Verweis (verraet nicht, dass es ihn gab)',
        );

        // Und was vom alten Weg im Protokoll landet:
        const geheim = 'Zx9QpL7mN2vB4cR8tY1wS6dF3gH5jK0a';
        check(
            redactPublicTokens(`/api/v1/signature-requests/public/${geheim}`) === '/api/v1/signature-requests/public/<token>',
            'der Schluessel im Pfad wird im Protokoll geschwaerzt (Unterschrift)',
        );
        check(
            redactPublicTokens(`/api/v1/maintenance/public/booking/${geheim}/confirm`) === '/api/v1/maintenance/public/booking/<token>/confirm',
            '... auch bei der Terminbestaetigung, mit erhaltenem Wegende',
        );
        check(
            redactPublicTokens(`/api/v1/public/enquiry/${geheim}`) === '/api/v1/public/enquiry/<token>',
            '... und beim oeffentlichen Anfrageformular',
        );
        check(
            redactPublicTokens('/api/v1/employees/abc123?page=2') === '/api/v1/employees/abc123?page=2',
            'gewoehnliche Wege bleiben unveraendert lesbar (kein blindes Schwaerzen)',
        );

        // Die Bremse: 60 je Viertelstunde. Der Zaehler laeuft schon, deshalb wird
        // nur geprueft, DASS es eine Bremse gibt (Kopfzeile), nicht bis zum 429.
        check(Boolean(viaHeader.headers.get('ratelimit-policy')), 'der Weg traegt jetzt eine Bremse (frueher: unbegrenzt ratbar)');
    } finally {
        await prisma.signatureRequest.deleteMany({ where: { id: { in: [fresh.id, stale.id] } } });
    }

    console.log(`\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} FEHLGESCHLAGEN.`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
