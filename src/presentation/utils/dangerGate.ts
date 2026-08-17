import { Request } from 'express';

import prisma from '../../infrastructure/database/prisma.client';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';

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

const crypto = new BcryptCryptoService();
const roleRepository = new RoleRepository();

export type DangerGateResult =
    | { ok: true; isSystemAdmin: boolean }
    | { ok: false; status: number; error: string; code: 'PASSWORD_REQUIRED' | 'PASSWORD_WRONG' };

/** Trägt die Person die Administratorrolle? (zwischengespeichert, kein Rundgang) */
export const isSystemAdminEmployee = async (employeeId: string): Promise<boolean> =>
    (await roleRepository.getEmployeeRoleInfo(employeeId)).isSystemAdmin;

/**
 * Darf diese Person die Löschung ausführen? Administrator: ja, ohne Kennwort.
 * Alle anderen: nur mit dem eigenen, richtigen Kennwort.
 */
export const checkDangerPassword = async (
    employeeId: string,
    password: unknown,
): Promise<DangerGateResult> => {
    if (await isSystemAdminEmployee(employeeId)) return { ok: true, isSystemAdmin: true };

    const value = typeof password === 'string' ? password : '';
    if (!value) {
        return {
            ok: false,
            status: 400,
            code: 'PASSWORD_REQUIRED',
            error: 'Zur Bestätigung ist Ihr Kennwort erforderlich.',
        };
    }

    const employee = await prisma.employee.findUnique({
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

/** Das Kennwort steht im Rumpf — bei DELETE ebenso wie bei POST. */
export const passwordFromRequest = (req: Request): unknown => (req.body as any)?.password;
