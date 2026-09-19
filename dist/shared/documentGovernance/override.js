"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.overrideErrorBody = exports.decideOverride = exports.isOverridable = exports.OVERRIDE_POLICIES = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
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
exports.OVERRIDE_POLICIES = {
    /** Auftrag zurück in den Entwurf, obwohl ein Termin vorbei/abgeschlossen ist.
        Termine werden ohnehin geparkt, nicht gelöscht. */
    ORDER_REVERT: ['MONTAGE_STARTED'],
    /** Offerte löschen, obwohl im Projekt geparkte Termine auf sie warten.
        Die Termine werden dabei abgesagt (mit Kalenderabsage). */
    TENDER_DELETE: ['PARKED_APPOINTMENT'],
};
const crypto = new BcryptCryptoService_1.BcryptCryptoService();
const roleRepository = new RoleRepository_1.RoleRepository();
const normalizeNumber = (value) => String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
/** Dürfen diese Sperren mit dieser Handlung überschritten werden? */
const isOverridable = (action, blockers) => blockers.length > 0 && blockers.every((blocker) => exports.OVERRIDE_POLICIES[action].includes(blocker));
exports.isOverridable = isOverridable;
/**
 * Die Prüfung — ohne Seiteneffekt. Der Aufrufer führt die Handlung aus und
 * schreibt den Verlaufseintrag mit `override: { blockers }`.
 */
const decideOverride = async (opts) => {
    const { action, employeeId, blockers, documentNumber, request } = opts;
    if (!(await roleRepository.getEmployeeRoleInfo(employeeId)).isSystemAdmin) {
        return { ok: false, status: 403, code: 'OVERRIDE_NOT_ADMIN', error: 'Nur die Systemverwaltung kann eine Sperre überschreiten.' };
    }
    if (!(0, exports.isOverridable)(action, blockers)) {
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
    const employee = await prisma_client_1.default.employee.findUnique({ where: { id: employeeId }, select: { passwordHash: true } });
    const matches = employee?.passwordHash ? await crypto.comparePassword(password, employee.passwordHash) : false;
    if (!matches) {
        return { ok: false, status: 403, code: 'OVERRIDE_PASSWORD_WRONG', error: 'Das Kennwort stimmt nicht.' };
    }
    return { ok: true, reason: reason.slice(0, 2000), blockers: [...blockers] };
};
exports.decideOverride = decideOverride;
/** Antwortkörper einer abgelehnten Ausnahme. */
const overrideErrorBody = (decision) => ({
    error: decision.error,
    code: decision.code,
    ...(decision.blockers ? { blockers: decision.blockers } : {}),
});
exports.overrideErrorBody = overrideErrorBody;
//# sourceMappingURL=override.js.map