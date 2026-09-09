import { z } from 'zod';
import { PASSWORD_REGEX, PASSWORD_POLICY_MESSAGE } from '../../application/validation/password';

/** New passwords must satisfy the central policy (see application/validation/password). */
export const strongPasswordSchema = z
    .string({ error: 'Parola zorunludur.' })
    .max(128, 'Parola en fazla 128 karakter olabilir.')
    .regex(PASSWORD_REGEX, PASSWORD_POLICY_MESSAGE);

const emailSchema = z
    .string({ error: 'E-posta zorunludur.' })
    .trim()
    .max(254, 'E-posta çok uzun.')
    .email('Geçerli bir e-posta adresi girin.');

const tokenSchema = z
    .string({ error: 'Token zorunludur.' })
    .min(1, 'Token zorunludur.')
    .max(4096, 'Token çok uzun.');

export const loginSchema = z.object({
    email: emailSchema,
    // Login must accept legacy passwords that predate the policy — only
    // presence is validated here, never the policy regex.
    password: z.string({ error: 'Parola zorunludur.' }).min(1, 'Parola zorunludur.').max(128),
});

export const emailRequestSchema = z.object({
    email: emailSchema,
});

export const tokenConfirmSchema = z.object({
    token: tokenSchema,
});

export const passwordResetConfirmSchema = z.object({
    token: tokenSchema,
    newPassword: strongPasswordSchema,
});

/**
 * Der Einmalcode des zweiten Faktors. Absichtlich grosszügig entgegengenommen:
 * Menschen tippen "482 193" mit Leerzeichen ab, und Aegis' Zwischenablage gibt
 * den Code je nach Einstellung mit Trennzeichen heraus. Geprüft wird nach dem
 * Aufräumen — genau sechs Ziffern (siehe shared/totp.ts).
 */
export const mfaVerifySchema = z.object({
    code: z
        .string({ error: 'Kod zorunludur.' })
        .max(32, 'Kod çok uzun.')
        .transform((value) => value.replace(/\D/g, ''))
        .refine((value) => value.length === 6, 'Kod 6 haneli olmalıdır.'),
});
