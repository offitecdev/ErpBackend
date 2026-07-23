"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertPasswordPolicy = exports.isPasswordCompliant = exports.PASSWORD_POLICY_MESSAGE = exports.PASSWORD_REGEX = void 0;
/**
 * Central password policy — the single source of truth for every place a NEW
 * password is accepted (employee create/update, password reset). Login is
 * deliberately exempt: existing passwords predating the policy must keep
 * working until they are changed.
 *
 * Policy: min 8 chars, at least one uppercase, one lowercase, one digit and
 * one special (non-alphanumeric) character.
 */
exports.PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
exports.PASSWORD_POLICY_MESSAGE = 'Parola en az 8 karakter olmalı ve en az bir büyük harf, bir küçük harf, bir rakam ve bir özel karakter içermelidir.';
const isPasswordCompliant = (password) => typeof password === 'string' && exports.PASSWORD_REGEX.test(password);
exports.isPasswordCompliant = isPasswordCompliant;
/** Throws with the user-facing policy message when the password is too weak. */
const assertPasswordPolicy = (password) => {
    if (!(0, exports.isPasswordCompliant)(password)) {
        throw new Error(exports.PASSWORD_POLICY_MESSAGE);
    }
};
exports.assertPasswordPolicy = assertPasswordPolicy;
//# sourceMappingURL=password.js.map