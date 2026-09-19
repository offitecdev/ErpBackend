"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireSystemAdmin = void 0;
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const roleRepository = new RoleRepository_1.RoleRepository();
/**
 * NUR DIE SYSTEMVERWALTUNG (16.09.2026, Schritt 4 / D3).
 *
 * Für Handlungen, die kein Recht der Rollentabelle sind, sondern der festen
 * Administratorrolle (`Role.isSystemAdmin`) gehören — etwa das Aufheben eines
 * Stornos: ein zurückgenommener Beleg lebt dann wieder, und das entscheidet
 * nicht, wer Aufträge bearbeiten darf.
 *
 * Läuft über denselben zwischengespeicherten Rolleneintrag wie die
 * Seitenstufen — kein zusätzlicher Rundgang zur Datenbank.
 */
const requireSystemAdmin = async (req, res, next) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Anmeldung erforderlich.' });
            return;
        }
        const { isSystemAdmin } = await roleRepository.getEmployeeRoleInfo(req.user.id);
        if (!isSystemAdmin) {
            res.status(403).json({
                error: 'Nur die Systemverwaltung kann diese Handlung ausführen.',
                code: 'SYSTEM_ADMIN_ONLY',
            });
            return;
        }
        next();
    }
    catch (error) {
        console.error('[SystemAdminMiddleware] error:', error);
        res.status(500).json({ error: 'Bei der Berechtigungsprüfung ist ein Fehler aufgetreten.' });
    }
};
exports.requireSystemAdmin = requireSystemAdmin;
//# sourceMappingURL=SystemAdminMiddleware.js.map