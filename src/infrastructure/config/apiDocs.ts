import { RuntimeEnv } from './runtime';

/**
 * ── WER DIE API-DOKUMENTATION SEHEN DARF ────────────────────────────────────
 *
 * Eigene Datei, damit die Regel geprüft werden kann, ohne einen zweiten Server
 * zu starten: `/api-docs` und `/swagger.json` hingen vorher ohne jede Anmeldung
 * am Produktivrechner und legten das vollständige Verzeichnis aller Endpunkte
 * samt Feldern offen.
 *
 * Die Umkehr ist bewusst asymmetrisch:
 *
 *  • Produktivbetrieb: AUS, es sei denn `OFFITEC_API_DOCS=on` — und dann nur
 *    für Angemeldete. Fehlt die Variable auf dem Server (der wahrscheinlichste
 *    Fall), ist der Weg zu. Fehlschluss in die sichere Richtung.
 *  • Sonst: AN, es sei denn `OFFITEC_API_DOCS=off`. In der Entwicklung ist die
 *    Dokumentation ein Werkzeug, kein Risiko.
 */
export interface ApiDocsAccess {
    enabled: boolean;
    /** Zusätzlich eine gültige Sitzung verlangen. */
    requireLogin: boolean;
}

export const apiDocsAccess = (env: RuntimeEnv, rawMode: string | undefined): ApiDocsAccess => {
    const mode = (rawMode || '').trim().toLowerCase();
    if (env === 'production') {
        return { enabled: mode === 'on', requireLogin: true };
    }
    return { enabled: mode !== 'off', requireLogin: false };
};
