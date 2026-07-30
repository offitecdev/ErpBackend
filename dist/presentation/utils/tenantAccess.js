"use strict";
/**
 * Per-employee company (tenant) assignment.
 *
 * An employee may be pinned to one or more tenants of their company tree; the
 * tenant switcher then only offers those and every request carrying another
 * tenant is rejected. An empty/absent list means "no restriction" — the whole
 * company tree, which is how every account behaved before the feature existed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAllowedTenantIds = void 0;
/** Normalizes the stored Json column. null = no restriction. */
const parseAllowedTenantIds = (value) => {
    if (!Array.isArray(value))
        return null;
    const ids = Array.from(new Set(value
        .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())));
    return ids.length ? ids : null;
};
exports.parseAllowedTenantIds = parseAllowedTenantIds;
//# sourceMappingURL=tenantAccess.js.map