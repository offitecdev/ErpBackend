"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.passwordFromRequest = exports.checkDangerPassword = exports.isSystemAdminEmployee = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
/**
 * ── KENNWORTSCHRANKE FÜR GEFÄHRLICHE AKTIONEN ────────────────────────────────
 *
 * Vorgabe (17.08.2026): eine Löschung im Produktbereich verlangt von JEDEM
 * Konto das eigene Kennwort — AUSSER vom Administrator, der ohne Rückfrage
 * durchkommt. Die Rolle entscheidet, nicht der Name des Kontos:
 * `Role.isSystemAdmin` ist dieselbe Fahne, an der auch die Seitenstufen hängen.
 *
 * Die Schranke gehört auf den Server, weil das Fenster im Browser nur zeigt,
 * was der Server ohnehin nachrechnet: das Frontend blendet das Kennwortfeld für
 * Administratoren aus, aber wer den Aufruf von Hand absetzt, kommt hier an.
 *
 * `code` reist mit, damit die Oberfläche die zwei häufigen Fälle in der Sprache
 * des Anwenders zeigen kann; der deutsche Text ist nur das Rückfallnetz.
 */
const crypto = new BcryptCryptoService_1.BcryptCryptoService();
const roleRepository = new RoleRepository_1.RoleRepository();
/** Trägt die Person die Administratorrolle? (zwischengespeichert, kein Rundgang) */
const isSystemAdminEmployee = async (employeeId) => (await roleRepository.getEmployeeRoleInfo(employeeId)).isSystemAdmin;
exports.isSystemAdminEmployee = isSystemAdminEmployee;
/**
 * Darf diese Person die Löschung ausführen? Administrator: ja, ohne Kennwort.
 * Alle anderen: nur mit dem eigenen, richtigen Kennwort.
 */
const checkDangerPassword = async (employeeId, password) => {
    if (await (0, exports.isSystemAdminEmployee)(employeeId))
        return { ok: true, isSystemAdmin: true };
    const value = typeof password === 'string' ? password : '';
    if (!value) {
        return {
            ok: false,
            status: 400,
            code: 'PASSWORD_REQUIRED',
            error: 'Zur Bestätigung ist Ihr Kennwort erforderlich.',
        };
    }
    const employee = await prisma_client_1.default.employee.findUnique({
        where: { id: employeeId },
        select: { passwordHash: true },
    });
    // Ohne Konto (oder ohne Hash) gibt es nichts zu vergleichen — das ist ein
    // fehlgeschlagener Nachweis, keine offene Tür.
    const matches = employee?.passwordHash
        ? await crypto.comparePassword(value, employee.passwordHash)
        : false;
    if (!matches) {
        return {
            ok: false,
            status: 403,
            code: 'PASSWORD_WRONG',
            error: 'Das Kennwort stimmt nicht.',
        };
    }
    return { ok: true, isSystemAdmin: false };
};
exports.checkDangerPassword = checkDangerPassword;
/** Das Kennwort steht im Rumpf — bei DELETE ebenso wie bei POST. */
const passwordFromRequest = (req) => req.body?.password;
exports.passwordFromRequest = passwordFromRequest;
//# sourceMappingURL=dangerGate.js.map