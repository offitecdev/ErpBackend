"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAnyPermission = exports.requirePermission = void 0;
const GetUserPermissionsUseCase_1 = require("../../application/use-cases/auth/GetUserPermissionsUseCase");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const roleRepo = new RoleRepository_1.RoleRepository();
const getPermissionsUseCase = new GetUserPermissionsUseCase_1.GetUserPermissionsUseCase(roleRepo);
/* ── Was eine abgewiesene Person LIEST ───────────────────────────────────────
 *
 * Bisher stand hier eine Aufzählung von Rechtenamen ("Erisim Engellendi: Bu
 * islem icin projects.view, projects.report, maintenance.tasks.manage
 * yetkilerinden biri gereklidir"). Das ist zweierlei zugleich falsch: es steht
 * in einer Sprache, die die Anwendung gar nicht führt, und es nennt interne
 * Namen, mit denen die Monteurin am Tablet nichts anfangen kann — sie las das
 * beim Öffnen ihrer Montage-Rapporte.
 *
 * Der SATZ sagt darum, was zu tun ist; die Rechtenamen reisen daneben in
 * `requiredPermissions` mit, damit Entwicklung und Protokoll sie weiterhin
 * haben, ohne dass sie jemand auf dem Bildschirm liest.
 */
const DENIED_MESSAGE = 'Zugriff verweigert: Ihrer Rolle fehlt die Berechtigung für diesen Vorgang. '
    + 'Bitte wenden Sie sich an die Administration.';
/** Eine Rolle, die GAR NICHTS vergibt, ist keine Entscheidung, sondern eine
    unfertige Rolle — dann steht auch dran, wo sie fertig gebaut wird. */
const NO_ROLE_MESSAGE = 'Ihrer Rolle sind noch keine Rechte zugewiesen. '
    + 'Die Administration vergibt sie unter Einstellungen → Berechtigungen.';
const requirePermission = (requiredPermission) => {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Anmeldung erforderlich.' });
                return;
            }
            const rbacStartedAt = Date.now();
            const userPermissions = await getPermissionsUseCase.execute(req.user.id);
            req.rbacDurMs = Date.now() - rbacStartedAt;
            // SECURE BY DEFAULT: a user with no permissions is denied on any
            // permission-gated route. Previously an empty set granted full
            // access ("first setup mode"), which made role-less users superusers.
            // TODO: First-setup/bootstrap access must be controlled by an explicit
            // tenant/system flag (e.g. a "needsBootstrap" tenant flag), never by
            // an empty permission set.
            if (userPermissions.length === 0 || !userPermissions.includes(requiredPermission)) {
                res.status(403).json({
                    error: userPermissions.length === 0 ? NO_ROLE_MESSAGE : DENIED_MESSAGE,
                    requiredPermissions: [requiredPermission],
                });
                return;
            }
            next();
        }
        catch (error) {
            console.error('[RbacMiddleware] error while checking permission:', requiredPermission, error);
            res.status(500).json({
                error: 'Bei der Berechtigungsprüfung ist ein Fehler aufgetreten.',
            });
        }
    };
};
exports.requirePermission = requirePermission;
const requireAnyPermission = (requiredPermissions) => {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Anmeldung erforderlich.' });
                return;
            }
            const userPermissions = await getPermissionsUseCase.execute(req.user.id);
            // SECURE BY DEFAULT: deny when the user has no permissions. See the
            // requirePermission note above — first-setup access must come from an
            // explicit tenant/system flag, not from an empty permission set.
            // TODO: gate bootstrap access behind an explicit tenant/system flag.
            if (userPermissions.length === 0 || !requiredPermissions.some((permission) => userPermissions.includes(permission))) {
                res.status(403).json({
                    error: userPermissions.length === 0 ? NO_ROLE_MESSAGE : DENIED_MESSAGE,
                    requiredPermissions,
                });
                return;
            }
            next();
        }
        catch (error) {
            console.error('[RbacMiddleware] error while checking any permission:', requiredPermissions, error);
            res.status(500).json({
                error: 'Bei der Berechtigungsprüfung ist ein Fehler aufgetreten.',
            });
        }
    };
};
exports.requireAnyPermission = requireAnyPermission;
//# sourceMappingURL=RbacMiddleware.js.map