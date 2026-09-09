import { nanoid } from 'nanoid';
import prisma from '../database/prisma.client';
import { PublicError } from '../../application/errors/AuthErrors';

/**
 * ── DIE OFFENEN ANMELDUNGEN EINER PERSON ────────────────────────────────────
 *
 * Bis hierher war die Anmeldung vollständig zustandslos: das Erneuerungstoken
 * galt 30 Tage, jede Erneuerung gab ein neues aus — und das alte blieb ebenso
 * gültig. `POST /auth/logout` löschte nur die Keks im Browser. Wer ein
 * Erneuerungstoken einmal abgriff (geteiltes Gerät, Sicherung, Protokoll eines
 * Zwischenservers), hatte damit einen Monat lang eine Sitzung, die NIEMAND
 * beenden konnte; die einzige Handhabe war ein Kennwortwechsel, weil der über
 * `pwdAt` alle Token auf einmal entwertet.
 *
 * Jetzt trägt jedes Erneuerungstoken zwei Kennungen:
 *
 *   jti  die Zeile, die genau zu DIESEM Token gehört.
 *   sid  die ANMELDUNG (`familyId`) — über alle Erneuerungen hinweg dieselbe.
 *
 * Daraus folgt alles Weitere: Abmelden entwertet die Zeile, ein Tausch
 * entwertet die alte sofort, und ein bereits getauschtes Token, das noch einmal
 * auftaucht, ist ein Wiedereinspielversuch — dann fällt die ganze Familie.
 *
 * ── WARUM ES EINE SCHONFRIST GIBT ───────────────────────────────────────────
 * Zwei Fenster teilen sich die Keks — und in DIESER Anwendung ist das der
 * Normalfall, nicht der Ausnahmefall: die geteilte Ansicht (SecondaryPane)
 * hängt eine zweite Ausgabe der Anwendung als Rahmen derselben Herkunft
 * daneben, mit eigener Axios-Instanz und eigener Einzelflug-Sperre. Laufen
 * beide gleichzeitig in ein 401, schicken beide dasselbe Erneuerungstoken.
 * Ohne Schonfrist legte der Verlierer die Anmeldung BEIDER lahm.
 *
 * Innerhalb von `REUSE_GRACE_MS` nach einem Tausch gilt ein zweiter Versuch
 * deshalb als Wettlauf: der Nachzügler bekommt die Kennung der Nachfolgezeile,
 * also dieselbe Sitzung wie der Gewinner.
 *
 * Das ist bewusst KEIN eigener Zweig: beide arbeiten danach auf derselben
 * Zeile, und der nächste Tausch des einen entwertet sie für den anderen. Bei
 * zwei Fenstern derselben Person kostet das nichts (die Schonfrist fängt es
 * wieder auf); bei einem GESTOHLENEN Token ist genau diese Kollision die
 * Entdeckung — dann fällt die ganze Familie. Ein eigener Zweig je Nachzügler
 * wäre bequemer und würde den Diebstahl nie mehr auffallen lassen.
 *
 * Die Frist ist entsprechend knapp: ein Wettlauf zweier Rahmen entscheidet sich
 * in Millisekunden, ein gestohlenes Token taucht selten in denselben Sekunden
 * auf wie das echte.
 */

/** Muss zur Laufzeit von `TOKEN_TTL.refresh` in JwtTokenService passen. */
export const REFRESH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Fenster, in dem ein zweiter Tausch desselben Tokens ein Wettlauf ist. */
export const REUSE_GRACE_MS = 10_000;

export type RevokeReason = 'rotated' | 'logout' | 'reuse' | 'account';

export interface RefreshSessionContext {
    ipAddress?: string | null;
    userAgent?: string | null;
}

/** Was in das Erneuerungstoken wandert. */
export interface RefreshSessionRef {
    jti: string;
    sid: string;
}

const sessions = () => (prisma as any).refreshSession;

const createRow = async (
    ref: RefreshSessionRef,
    employeeId: string,
    tenantId: string,
    context: RefreshSessionContext,
): Promise<RefreshSessionRef> => {
    await sessions().create({
        data: {
            id: ref.jti,
            familyId: ref.sid,
            employeeId,
            tenantId,
            expiresAt: new Date(Date.now() + REFRESH_SESSION_TTL_MS),
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ? String(context.userAgent).slice(0, 512) : null,
        },
    });
    return ref;
};

/** Eine neue Anmeldung: neue Familie, erste Zeile darin. */
export const startRefreshSession = async (
    employeeId: string,
    tenantId: string,
    context: RefreshSessionContext = {},
): Promise<RefreshSessionRef> => {
    try {
        return await createRow({ jti: nanoid(), sid: nanoid() }, employeeId, tenantId, context);
    } catch (error: any) {
        /* Scheitert der Schreibvorgang, wird NICHT angemeldet (ohne Zeile gäbe
           es wieder eine Sitzung, die niemand beenden kann). Die Meldung der
           Datenbank bleibt aber hier: die Anmeldeantwort reicht `error.message`
           an den nicht angemeldeten Aufrufer durch und verriete Tabellen- und
           Spaltennamen. */
        console.error('[RefreshSession] Anmeldung konnte nicht eröffnet werden:', error?.message || error);
        throw new PublicError('Oturum başlatılamadı. Lütfen daha sonra tekrar deneyin.');
    }
};

/** Jede noch offene Zeile einer Anmeldung entwerten. */
export const revokeRefreshFamily = async (familyId: string, reason: RevokeReason): Promise<void> => {
    await sessions().updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
};

/** Eine einzelne Zeile entwerten (Abmelden). */
export const revokeRefreshSession = async (jti: string, reason: RevokeReason): Promise<void> => {
    await sessions().updateMany({
        where: { id: jti, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
};

/**
 * ALLE Anmeldungen einer Person beenden. Gerufen bei Sperre, Löschung,
 * Stilllegung und Kennwortwechsel — `pwdAt` entwertet die Token ohnehin, aber
 * die Zeilen sollen nicht bis zum Ablauf offen daneben liegen bleiben.
 */
export const revokeAllRefreshSessions = async (employeeId: string, reason: RevokeReason = 'account'): Promise<void> => {
    await sessions().updateMany({
        where: { employeeId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
};

export class RefreshSessionError extends PublicError {}

/**
 * Tausch: die vorgelegte Zeile stirbt, eine neue tritt an ihre Stelle.
 * Wirft, wenn das Token nicht (mehr) zu einer offenen Anmeldung gehört — und
 * legt bei einer Wiedereinspielung die ganze Familie still.
 */
export const rotateRefreshSession = async (
    ref: RefreshSessionRef,
    employeeId: string,
    tenantId: string,
    context: RefreshSessionContext = {},
): Promise<RefreshSessionRef> => {
    const invalid = () => new RefreshSessionError('Oturum sonlandırılmış. Lütfen tekrar giriş yapın.');

    const row = await sessions().findUnique({ where: { id: ref.jti } });

    // Unbekannt: die Zeile ist abgeräumt oder das Token frei erfunden. Die
    // genannte Familie wird vorsorglich geschlossen.
    if (!row) {
        await revokeRefreshFamily(ref.sid, 'reuse');
        throw invalid();
    }
    // Das Token nennt eine andere Person oder eine andere Anmeldung, als die
    // Zeile kennt — es ist zusammengesetzt, nicht ausgestellt.
    if (row.employeeId !== employeeId || row.familyId !== ref.sid) {
        await revokeRefreshFamily(row.familyId, 'reuse');
        throw invalid();
    }
    if (row.expiresAt.getTime() <= Date.now()) throw invalid();

    if (row.revokedAt) {
        // Wettlauf zweier Fenster (siehe Schonfrist oben): an der Nachfolgezeile
        // weiterführen, statt beide Fenster abzumelden.
        const raced = row.revokedReason === 'rotated'
            && row.replacedById
            && Date.now() - row.revokedAt.getTime() <= REUSE_GRACE_MS;
        if (raced) {
            const successor = await sessions().findUnique({ where: { id: row.replacedById } });
            if (successor && !successor.revokedAt && successor.expiresAt.getTime() > Date.now()) {
                return { jti: successor.id, sid: successor.familyId };
            }
        }
        // Sonst: ein Token, das schon getauscht (oder abgemeldet) war, ist
        // wieder aufgetaucht. Die ganze Anmeldung fällt.
        await revokeRefreshFamily(row.familyId, 'reuse');
        throw invalid();
    }

    const next: RefreshSessionRef = { jti: nanoid(), sid: row.familyId };
    await createRow(next, employeeId, tenantId, context);
    await sessions().update({
        where: { id: row.id },
        data: { revokedAt: new Date(), revokedReason: 'rotated', replacedById: next.jti },
    });
    return next;
};

/**
 * Abgelaufene Zeilen abräumen. Entwertete Zeilen bleiben bis zum Ablauf ihrer
 * Frist stehen — nur so ist ein wiedereingespieltes Token von einem frei
 * erfundenen zu unterscheiden.
 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;

export const pruneRefreshSessions = async (): Promise<number> => {
    const result = await sessions().deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return result.count ?? 0;
};

export const startRefreshSessionCleanup = (): void => {
    const run = () => {
        pruneRefreshSessions()
            .then((count) => { if (count) console.log(`[RefreshSession] ${count} abgelaufene Sitzungen abgeräumt.`); })
            .catch((error) => console.error('[RefreshSession] Aufräumen fehlgeschlagen:', error?.message || error));
    };
    // Nicht beim Start: der erste Lauf soll nicht mit dem Aufwärmen der
    // Verbindungen zusammenfallen.
    const timer = setInterval(run, CLEANUP_INTERVAL_MS);
    timer.unref?.();
};
