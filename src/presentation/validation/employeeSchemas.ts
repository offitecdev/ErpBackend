import { z } from 'zod';
import { strongPasswordSchema } from './authSchemas';

const nameSchema = z.string().trim().min(1, 'Bu alan zorunludur.').max(100, 'En fazla 100 karakter.');
const emailSchema = z.string().trim().max(254).email('Geçerli bir e-posta adresi girin.');
/** Company assignment: tenant ids (empty list / null = every company of the tree). */
const allowedTenantIdsSchema = z.array(z.string().trim().min(1).max(64)).max(200).nullable().optional();

/**
 * Loose objects: unknown extra keys pass through untouched (the use cases pick
 * the fields they persist), while the security-relevant fields are strict.
 */
export const employeeCreateSchema = z.looseObject({
    firstName: nameSchema,
    lastName: nameSchema,
    email: emailSchema,
    password: strongPasswordSchema,
    allowedTenantIds: allowedTenantIdsSchema,
});

export const employeeUpdateSchema = z.looseObject({
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    email: emailSchema.optional(),
    password: strongPasswordSchema.optional(),
    allowedTenantIds: allowedTenantIdsSchema,
});
