"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.employeeUpdateSchema = exports.employeeCreateSchema = void 0;
const zod_1 = require("zod");
const authSchemas_1 = require("./authSchemas");
const nameSchema = zod_1.z.string().trim().min(1, 'Bu alan zorunludur.').max(100, 'En fazla 100 karakter.');
const emailSchema = zod_1.z.string().trim().max(254).email('Geçerli bir e-posta adresi girin.');
/**
 * Loose objects: unknown extra keys pass through untouched (the use cases pick
 * the fields they persist), while the security-relevant fields are strict.
 */
exports.employeeCreateSchema = zod_1.z.looseObject({
    firstName: nameSchema,
    lastName: nameSchema,
    email: emailSchema,
    password: authSchemas_1.strongPasswordSchema,
});
exports.employeeUpdateSchema = zod_1.z.looseObject({
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    email: emailSchema.optional(),
    password: authSchemas_1.strongPasswordSchema.optional(),
});
//# sourceMappingURL=employeeSchemas.js.map