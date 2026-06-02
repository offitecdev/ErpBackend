"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
class AuthController {
    loginUseCase;
    getUserPermissionsUseCase;
    getMeUseCase;
    constructor(loginUseCase, getUserPermissionsUseCase, getMeUseCase) {
        this.loginUseCase = loginUseCase;
        this.getUserPermissionsUseCase = getUserPermissionsUseCase;
        this.getMeUseCase = getMeUseCase;
    }
    async login(req, res) {
        try {
            const { email, password } = req.body;
            const result = await this.loginUseCase.execute(email, password);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getPermissions(req, res) {
        try {
            const employeeId = req.user?.id;
            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const permissions = await this.getUserPermissionsUseCase.execute(employeeId);
            res.status(200).json({ permissions });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
    async getMe(req, res) {
        try {
            const employeId = req.user?.id;
            if (!employeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const employee = await this.getMeUseCase.execute(employeId);
            return res.status(200).json(employee);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=AuthController.js.map