"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirePermission = void 0;
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
//# sourceMappingURL=RbacMiddleware.js.map