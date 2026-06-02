"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BcryptCryptoService = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
class BcryptCryptoService {
    async hashPassword(password) {
        return await bcrypt_1.default.hash(password, 12);
    }
    async comparePassword(password, hash) {
        return await bcrypt_1.default.compare(password, hash);
    }
}
exports.BcryptCryptoService = BcryptCryptoService;
//# sourceMappingURL=BcryptCryptoService.js.map