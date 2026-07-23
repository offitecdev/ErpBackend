/**
 * Central password policy — the single source of truth for every place a NEW
 * password is accepted (employee create/update, password reset). Login is
 * deliberately exempt: existing passwords predating the policy must keep
 * working until they are changed.
 *
 * Policy: min 8 chars, at least one uppercase, one lowercase, one digit and
 * one special (non-alphanumeric) character.
 */
export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

export const PASSWORD_POLICY_MESSAGE =
    'Parola en az 8 karakter olmalı ve en az bir büyük harf, bir küçük harf, bir rakam ve bir özel karakter içermelidir.';

export const isPasswordCompliant = (password: string): boolean =>
    typeof password === 'string' && PASSWORD_REGEX.test(password);

/** Throws with the user-facing policy message when the password is too weak. */
export const assertPasswordPolicy = (password: string): void => {
    if (!isPasswordCompliant(password)) {
        throw new Error(PASSWORD_POLICY_MESSAGE);
    }
};
