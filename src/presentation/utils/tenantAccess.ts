/**
 * Per-employee company (tenant) assignment.
 *
 * An employee may be pinned to one or more tenants of their company tree; the
 * tenant switcher then only offers those and every request carrying another
 * tenant falls back to a permitted one.
 *
 * An empty/absent list no longer means "the whole tree" (31.08.2026): it means
 * the employee's OWN company and nothing else. Sister companies are reached
 * only by a deliberate assignment, so staff of one sub-company never see the
 * others — nor their users and customers — in any picker.
 */

/** Normalizes the stored Json column. null = no assignment saved (= own company only). */
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
