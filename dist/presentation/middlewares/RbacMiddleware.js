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
            // Kullanıcıya hiç rol atanmamışsa (boş dizi) → tam erişim ver (ilk kurulum modu)
            if (userPermissions.length === 0) {
                next();
                return;
            }
            if (!userPermissions.includes(requiredPermission)) {
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
                detail: error?.message,
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
            if (userPermissions.length === 0) {
                next();
                return;
            }
            if (!requiredPermissions.some((permission) => userPermissions.includes(permission))) {
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
                detail: error?.message,
            });
        }
    };
};
exports.requireAnyPermission = requireAnyPermission;
//# sourceMappingURL=RbacMiddleware.js.map