"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.passwordResetConfirmSchema = exports.tokenConfirmSchema = exports.emailRequestSchema = exports.loginSchema = exports.strongPasswordSchema = void 0;
const zod_1 = require("zod");
const password_1 = require("../../application/validation/password");
/** New passwords must satisfy the central policy (see application/validation/password). */
exports.strongPasswordSchema = zod_1.z
    .string({ error: 'Parola zorunludur.' })
    .max(128, 'Parola en fazla 128 karakter olabilir.')
    .regex(password_1.PASSWORD_REGEX, password_1.PASSWORD_POLICY_MESSAGE);
const emailSchema = zod_1.z
    .string({ error: 'E-posta zorunludur.' })
    .trim()
    .max(254, 'E-posta çok uzun.')
    .email('Geçerli bir e-posta adresi girin.');
const tokenSchema = zod_1.z
    .string({ error: 'Token zorunludur.' })
    .min(1, 'Token zorunludur.')
    .max(4096, 'Token çok uzun.');
exports.loginSchema = zod_1.z.object({
    email: emailSchema,
    // Login must accept legacy passwords that predate the policy — only
    // presence is validated here, never the policy regex.
    password: zod_1.z.string({ error: 'Parola zorunludur.' }).min(1, 'Parola zorunludur.').max(128),
});
exports.emailRequestSchema = zod_1.z.object({
    email: emailSchema,
});
exports.tokenConfirmSchema = zod_1.z.object({
    token: tokenSchema,
});
exports.passwordResetConfirmSchema = zod_1.z.object({
    token: tokenSchema,
    newPassword: exports.strongPasswordSchema,
});
//# sourceMappingURL=authSchemas.js.map