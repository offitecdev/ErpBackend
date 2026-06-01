import 'express-serve-static-core';

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                tenantId: string;
                homeTenantId: string;
                email: string;
            };
        }
    }
}
