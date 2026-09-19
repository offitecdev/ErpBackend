import prisma from '../../infrastructure/database/prisma.client';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';

/**
 * ── DIE AUSNAHMETÜR DER SYSTEMVERWALTUNG (16.09.2026, Schritt 4 / D4) ─────────
 *
 * Für normale Rollen ist eine Sperre («an diesem Auftrag hängt schon ein
 * begonnener Termin») eine Wand. Für die Systemverwaltung ist sie das auch —
 * aber daneben steht «trotzdem ausführen», und das hat einen Preis:
 *
 *   1. nur die Administratorrolle (`Role.isSystemAdmin`);
 *   2. ein Grund im Klartext (mindestens zehn Zeichen);
 *   3. die Belegnummer, von Hand abgetippt — gegen den Griff zum falschen Beleg;
 *   4. das eigene Kennwort, AUCH für die Administratorrolle (anders als bei
 *      der Produktlöschung — hier wird eine Regel gebrochen, nicht nur gelöscht);
 *   5. ein Verlaufseintrag mit `override = true`, der am Beleg sichtbar bleibt.
 *
 * WELCHE Sperren überschritten werden dürfen, steht in OVERRIDE_POLICIES — und
 * nur Sperren, deren Überschreiten NICHTS Unterschriebenes oder Verbuchtes
 * zerstört. Rechnungen, Rapporte, Lagerbewegungen und Nachträge sind darum
 * nirgends aufgeführt: dafür gibt es Storno und Gutschrift, keine Ausnahme.
 */

export const OVERRIDE_POLICIES = {
    /** Auftrag zurück in den Entwurf, obwohl ein Termin vorbei/abgeschlossen ist.
        Termine werden ohnehin geparkt, nicht gelöscht. */
    ORDER_REVERT: ['MONTAGE_STARTED'],
    /** Offerte löschen, obwohl im Projekt geparkte Termine auf sie warten.
        Die Termine werden dabei abgesagt (mit Kalenderabsage). */
    TENDER_DELETE: ['PARKED_APPOINTMENT'],
} as const satisfies Record<string, readonly string[]>;

export type OverrideAction = keyof typeof OVERRIDE_POLICIES;

export type OverrideCode =
    | 'OVERRIDE_NOT_ADMIN'
    | 'OVERRIDE_NOT_ALLOWED'
    | 'OVERRIDE_REASON_REQUIRED'
    | 'OVERRIDE_NUMBER_MISMATCH'
    | 'OVERRIDE_PASSWORD_REQUIRED'
    | 'OVERRIDE_PASSWORD_WRONG';

export interface OverrideRequest {
    reason?: unknown;
    confirmNumber?: unknown;
    password?: unknown;
}

export type OverrideDecision =
    | { ok: true; reason: string; blockers: string[] }
    | { ok: false; status: number; code: OverrideCode; error: string; blockers?: string[] };

const crypto = new BcryptCryptoService();
const roleRepository = new RoleRepository();

const normalizeNumber = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();

/** Dürfen diese Sperren mit dieser Handlung überschritten werden? */
export const isOverridable = (action: OverrideAction, blockers: readonly string[]): boolean =>
    blockers.length > 0 && blockers.every((blocker) => (OVERRIDE_POLICIES[action] as readonly string[]).includes(blocker));

/**
 * Die Prüfung — ohne Seiteneffekt. Der Aufrufer führt die Handlung aus und
 * schreibt den Verlaufseintrag mit `override: { blockers }`.
 */
export const decideOverride = async (opts: {
    action: OverrideAction;
    employeeId: string;
    blockers: readonly string[];
    documentNumber: string | null | undefined;
    request: OverrideRequest | null | undefined;
}): Promise<OverrideDecision> => {
    const { action, employeeId, blockers, documentNumber, request } = opts;

    if (!(await roleRepository.getEmployeeRoleInfo(employeeId)).isSystemAdmin) {
        return { ok: false, status: 403, code: 'OVERRIDE_NOT_ADMIN', error: 'Nur die Systemverwaltung kann eine Sperre überschreiten.' };
    }
    if (!isOverridable(action, blockers)) {
        return {
            ok: false,
            status: 409,
            code: 'OVERRIDE_NOT_ALLOWED',
            error: 'Diese Sperre kann nicht überschritten werden — dafür gibt es Storno oder Gutschrift.',
            blockers: [...blockers],
        };
    }
    const reason = String(request?.reason ?? '').trim();
    if (reason.length < 10) {
        return { ok: false, status: 400, code: 'OVERRIDE_REASON_REQUIRED', error: 'Bitte den Grund für den Eingriff angeben (mindestens 10 Zeichen).' };
    }
    if (!documentNumber || normalizeNumber(request?.confirmNumber) !== normalizeNumber(documentNumber)) {
        return { ok: false, status: 400, code: 'OVERRIDE_NUMBER_MISMATCH', error: 'Die eingegebene Belegnummer stimmt nicht.' };
    }
    const password = typeof request?.password === 'string' ? request.password : '';
    if (!password) {
        return { ok: false, status: 400, code: 'OVERRIDE_PASSWORD_REQUIRED', error: 'Zur Bestätigung ist Ihr Kennwort erforderlich.' };
    }
    const employee = await (prisma as any).employee.findUnique({ where: { id: employeeId }, select: { passwordHash: true } });
    const matches = employee?.passwordHash ? await crypto.comparePassword(password, employee.passwordHash) : false;
    if (!matches) {
        return { ok: false, status: 403, code: 'OVERRIDE_PASSWORD_WRONG', error: 'Das Kennwort stimmt nicht.' };
    }
    return { ok: true, reason: reason.slice(0, 2000), blockers: [...blockers] };
};

/** Antwortkörper einer abgelehnten Ausnahme. */
export const overrideErrorBody = (decision: Extract<OverrideDecision, { ok: false }>) => ({
    error: decision.error,
    code: decision.code,
    ...(decision.blockers ? { blockers: decision.blockers } : {}),
});
