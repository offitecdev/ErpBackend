/**
 * ── WAS EIN AUFRUFER LESEN DARF ─────────────────────────────────────────────
 *
 * Die Anmeldewege beantworteten ihre Fehler mit `error.message` — also mit dem,
 * was auch immer geworfen wurde. Gedacht war das für die eigenen Sätze
 * ("E-posta veya parola hatalı."), getroffen hat es aber jeden Fehler:
 *
 *   • Fehlt ein JWT-Geheimnis, antwortete die NICHT angemeldete Anmeldung mit
 *     "JWT secret eksik: OFFITEC_JWT_ACCESS_SECRET tanımlanmamış." — der Name
 *     der Umgebungsvariable, an die Welt.
 *   • Eine doppelte E-Mail auf der Zugangsfläche antwortete mit
 *     "Unique constraint failed on the constraint: `Employee_email_key`" —
 *     Tabellen- und Spaltennamen, an die Welt.
 *
 * Die Unterscheidung lässt sich nicht erraten, sie muss AUSGESPROCHEN werden:
 * ein Satz, der nach draussen darf, wird als `PublicError` geworfen. Alles
 * andere — Prisma, Netzwerk, Programmierfehler, fehlende Konfiguration — ist
 * innerlich, wird protokolliert und nach draussen zu einem festen Satz.
 *
 * Die Richtung stimmt damit auch für alles, was noch kommt: ein neu geworfener
 * `new Error(...)` ist stumm, bis jemand ihn ausdrücklich öffentlich macht.
 */

/** Ein Satz, der bewusst FÜR den Aufrufer geschrieben ist. */
export class PublicError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PublicError';
    }
}

/**
 * Zu viele Fehlversuche auf DIESES Konto (siehe LoginThrottle). Trägt die
 * Wartezeit mit, damit die Antwort ein `Retry-After` setzen kann.
 */
export class TooManyAttemptsError extends PublicError {
    constructor(message: string, public readonly retryAfterSeconds: number) {
        super(message);
        this.name = 'TooManyAttemptsError';
    }
}

/** Der feste Satz, wenn der Fehler nichts ist, was jemand lesen soll. */
export const GENERIC_ERROR_MESSAGE = 'İşlem şu anda gerçekleştirilemiyor. Lütfen daha sonra tekrar deneyin.';

/**
 * Der Satz für die Antwort: der eigene, wenn er als öffentlich geworfen wurde —
 * sonst der feste, und das Innere geht ins Protokoll des Servers.
 *
 * `context` benennt die Stelle, damit im Protokoll steht, WO es geknallt hat;
 * ohne das ist eine generische Antwort nicht mehr nachzuvollziehen.
 */
export const toPublicMessage = (
    error: unknown,
    context: string,
    fallback: string = GENERIC_ERROR_MESSAGE,
): string => {
    if (error instanceof PublicError) return error.message;
    console.error(`[${context}]`, error instanceof Error ? (error.stack || error.message) : error);
    return fallback;
};
