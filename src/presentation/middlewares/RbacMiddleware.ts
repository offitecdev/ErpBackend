import { Request, Response, NextFunction } from 'express';
import { GetUserPermissionsUseCase } from '../../application/use-cases/auth/GetUserPermissionsUseCase';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';

const roleRepo = new RoleRepository();
const getPermissionsUseCase = new GetUserPermissionsUseCase(roleRepo);

export const requirePermission = (requiredPermission: string) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        } catch (error: any) {
            console.error('[RbacMiddleware] error while checking permission:', requiredPermission, error);
            res.status(500).json({
                error: 'Yetki kontrolü sırasında bir hata oluştu.',
                detail: error?.message,
            });
        }
    };
};

export const requireAnyPermission = (requiredPermissions: string[]) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        } catch (error: any) {
            console.error('[RbacMiddleware] error while checking any permission:', requiredPermissions, error);
            res.status(500).json({
                error: 'Yetki kontrolu sirasinda bir hata olustu.',
                detail: error?.message,
            });
        }
    };
};
