/**
 * Per-employee company (tenant) assignment.
 *
 * An employee may be pinned to one or more tenants of their company tree; the
 * tenant switcher then only offers those and every request carrying another
 * tenant is rejected. An empty/absent list means "no restriction" — the whole
 * company tree, which is how every account behaved before the feature existed.
 */

/** Normalizes the stored Json column. null = no restriction. */
export const parseAllowedTenantIds = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const ids = Array.from(
        new Set(
            value
                .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                .map((entry) => entry.trim()),
        ),
    );
    return ids.length ? ids : null;
};
