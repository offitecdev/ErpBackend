/**
 * ── ÖFFENTLICHE SCHLÜSSEL GEHÖREN NICHT INS ZUGRIFFSPROTOKOLL ───────────────
 *
 * Die Wege mit einem Schlüssel IM PFAD — die Unterschriftsseite der Kundin, die
 * Terminbestätigung, das öffentliche Anfrageformular — landeten über morgans
 * `:url` wörtlich in `server.out.log`. Wer das Protokoll lesen darf (Betrieb,
 * Sicherung, ein Werkzeug zur Protokollauswertung), konnte damit
 * unterschreiben oder Termine bestätigen.
 *
 * Die Aufrufe der Anwendung schicken den Schlüssel inzwischen im Kopf
 * `X-Public-Token` (siehe publicToken.ts). Diese Liste deckt weiterhin die
 * ALTEN Verweise ab — und alles, was jemand von Hand aufruft.
 *
 * Bewusst eine feste Liste statt einer Regel wie "alles, was lang aussieht":
 * eine solche Regel schwärzt irgendwann auch Datensatzkennungen und macht das
 * Protokoll zum Nachsehen unbrauchbar.
 *
 * NEUE öffentliche Wege mit Schlüssel im Pfad gehören hier hinein.
 */
const PUBLIC_TOKEN_URL_PATTERNS: readonly RegExp[] = [
    /(\/signature-requests\/public\/)[^/?]+/i,
    /(\/maintenance\/public\/booking\/)[^/?]+/i,
    /(\/public\/enquiry\/)[^/?]+/i,
];

export const redactPublicTokens = (url: string): string => {
    let redacted = url;
    for (const pattern of PUBLIC_TOKEN_URL_PATTERNS) {
        redacted = redacted.replace(pattern, '$1<token>');
    }
    return redacted;
};
