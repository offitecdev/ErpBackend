"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAnyPermission = exports.requirePermission = void 0;
const GetUserPermissionsUseCase_1 = require("../../application/use-cases/auth/GetUserPermissionsUseCase");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const roleRepo = new RoleRepository_1.RoleRepository();
const getPermissionsUseCase = new GetUserPermissionsUseCase_1.GetUserPermissionsUseCase(roleRepo);
const requirePermission = (requiredPermission) => {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Kimlik doğrulanmamış kullanıcı.' });
                return;
            }
            const userPermissions = await getPermissionsUseCase.execute(req.user.id);
            // SECURE BY DEFAULT: a user with no permissions is denied on any
            // permission-gated route. Previously an empty set granted full
            // access ("first setup mode"), which made role-less users superusers.
            // TODO: First-setup/bootstrap access must be controlled by an explicit
            // tenant/system flag (e.g. a "needsBootstrap" tenant flag), never by
            // an empty permission set.
            if (userPermissions.length === 0 || !userPermissions.includes(requiredPermission)) {
                res.status(403).json({
                    error: `Erişim Engellendi: Bu işlem için '${requiredPermission}' yetkisine sahip değilsiniz.`
                });
                return;
            }
            next();
        }
        catch (error) {
            console.error('[RbacMiddleware] error while checking permission:', requiredPermission, error);
            res.status(500).json({
                error: 'Yetki kontrolü sırasında bir hata oluştu.',
            });
        }
    };
};
exports.requirePermission = requirePermission;
const requireAnyPermission = (requiredPermissions) => {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Kimlik dogrulanmamis kullanici.' });
                return;
            }
            const userPermissions = await getPermissionsUseCase.execute(req.user.id);
            // SECURE BY DEFAULT: deny when the user has no permissions. See the
            // requirePermission note above — first-setup access must come from an
            // explicit tenant/system flag, not from an empty permission set.
            // TODO: gate bootstrap access behind an explicit tenant/system flag.
            if (userPermissions.length === 0 || !requiredPermissions.some((permission) => userPermissions.includes(permission))) {
                res.status(403).json({
                    error: `Erisim Engellendi: Bu islem icin ${requiredPermissions.join(', ')} yetkilerinden biri gereklidir.`
                });
                return;
            }
            next();
        }
        catch (error) {
            console.error('[RbacMiddleware] error while checking any permission:', requiredPermissions, error);
            res.status(500).json({
                error: 'Yetki kontrolu sirasinda bir hata olustu.',
            });
        }
    };
};
exports.requireAnyPermission = requireAnyPermission;
//# sourceMappingURL=RbacMiddleware.js.map