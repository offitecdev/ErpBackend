/**
 * Module catalog: groups the flat permission strings into user-facing modules
 * with plain read / write / delete actions. The frontend mirrors this file
 * (src/lib/moduleCatalog.ts) for the role editor and menu filtering; the
 * backend copy is the enforcement authority — a company mapped to a
 * ModuleProfile may only put permissions of its enabled modules into roles.
 */
export type ModuleAction = 'read' | 'write' | 'delete';

export interface ModuleDefinition {
    key: string;
    /** Never gated by a company category — the admin must keep role/user/company
        management everywhere, otherwise a category could lock admins out. */
    alwaysAvailable?: boolean;
    actions: Partial<Record<ModuleAction, string[]>>;
}

export const MODULE_CATALOG: ModuleDefinition[] = [
    {
        key: 'personnel',
        actions: {
            read: ['employees.view', 'attendance.read', 'leaves.read'],
            write: ['employees.create', 'employees.update', 'attendance.create', 'attendance.update', 'leaves.create', 'leaves.approve'],
            delete: ['employees.delete', 'leaves.delete'],
        },
    },
    {
        key: 'crm',
        actions: {
            read: ['crm.customers.view', 'tenders.view'],
            write: [
                'crm.customers.create', 'crm.customers.addNote', 'crm.activities.create', 'crm.documents.upload',
                'tenders.create', 'tenders.update', 'tenders.manage', 'tenders.calculate',
                'tenders.import', 'tenders.export', 'tenders.approve',
            ],
        },
    },
    {
        key: 'projects',
        actions: {
            read: ['projects.view'],
            write: [
                'projects.create', 'projects.manage', 'projects.approve', 'projects.report',
                'projects.createAddonOrder', 'projects.approveVariation', 'projects.bookings.manage',
                'projects.mail', 'mail.manage', 'mail.send',
            ],
        },
    },
    {
        key: 'inventory',
        actions: {
            read: ['inventory.view'],
            write: ['inventory.manage', 'inventory.transfer', 'inventory.proposals.manage', 'inventory.articles.create', 'inventory.articles.update'],
            delete: ['inventory.articles.delete'],
        },
    },
    {
        key: 'logistics',
        actions: {
            read: ['logistics.view'],
            write: ['logistics.manage'],
        },
    },
    {
        key: 'maintenance',
        actions: {
            write: [
                'maintenance.contracts.manage', 'maintenance.tasks.manage', 'maintenance.reports.manage',
                'regie.calls.manage', 'regie.reports.manage', 'workorders.manage',
            ],
        },
    },
    // Pure page-visibility modules (no role permissions of their own): used in
    // company categories and role module packages to switch pages on/off.
    {
        key: 'calendar',
        actions: {},
    },
    {
        key: 'fieldwork',
        actions: {},
    },
    {
        key: 'billing',
        actions: {
            read: ['billing.view'],
            write: ['billing.create', 'billing.manage'],
        },
    },
    {
        key: 'settings',
        actions: {},
    },
    {
        key: 'administration',
        alwaysAvailable: true,
        actions: {
            write: ['roles.manage', 'users.manage', 'tenants.create', 'tenants.update'],
        },
    },
];

export const MODULE_KEYS = MODULE_CATALOG.map((moduleDef) => moduleDef.key);

const ALWAYS_AVAILABLE_MODULE_KEYS: ReadonlySet<string> = new Set(
    MODULE_CATALOG.filter((moduleDef) => moduleDef.alwaysAvailable).map((moduleDef) => moduleDef.key),
);

/** Company-level module switch: the company category ("Numara" profile) is the
    authority for every module — pass its moduleKeys, or null/undefined when the
    company has no category (then everything is enabled, matching the frontend). */
export const isModuleEnabledForCategory = (categoryModuleKeys: unknown, moduleKey: string): boolean =>
    ALWAYS_AVAILABLE_MODULE_KEYS.has(moduleKey)
    || !Array.isArray(categoryModuleKeys)
    || categoryModuleKeys.map(String).includes(moduleKey);

const modulePermissionNames = (moduleDef: ModuleDefinition): string[] =>
    Object.values(moduleDef.actions).flat().filter(Boolean) as string[];

/** Every permission name that company categories can gate — names outside
    this set are never blocked (future/unmapped permissions and the
    always-available administration module stay assignable everywhere). */
export const CATALOG_PERMISSION_NAMES: ReadonlySet<string> = new Set(
    MODULE_CATALOG
        .filter((moduleDef) => !moduleDef.alwaysAvailable)
        .flatMap(modulePermissionNames),
);

/** Union of permission names granted by a set of enabled module keys. */
export const permissionsForModules = (moduleKeys: string[]): Set<string> => {
    const enabled = new Set(moduleKeys);
    return new Set(
        MODULE_CATALOG
            .filter((moduleDef) => enabled.has(moduleDef.key))
            .flatMap(modulePermissionNames),
    );
};

export const sanitizeModuleKeys = (input: unknown): string[] =>
    Array.isArray(input)
        ? [...new Set(input.map(String))].filter((key) => MODULE_KEYS.includes(key))
        : [];
