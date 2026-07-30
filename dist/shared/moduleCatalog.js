"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeModuleKeys = exports.permissionsForModules = exports.CATALOG_PERMISSION_NAMES = exports.MODULE_KEYS = exports.MODULE_CATALOG = void 0;
exports.MODULE_CATALOG = [
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
    // company categories and personal employee packages to switch pages on/off.
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
        key: 'administration',
        alwaysAvailable: true,
        actions: {
            write: ['roles.manage', 'users.manage', 'tenants.create', 'tenants.update'],
        },
    },
];
exports.MODULE_KEYS = exports.MODULE_CATALOG.map((moduleDef) => moduleDef.key);
const modulePermissionNames = (moduleDef) => Object.values(moduleDef.actions).flat().filter(Boolean);
/** Every permission name that company categories can gate — names outside
    this set are never blocked (future/unmapped permissions and the
    always-available administration module stay assignable everywhere). */
exports.CATALOG_PERMISSION_NAMES = new Set(exports.MODULE_CATALOG
    .filter((moduleDef) => !moduleDef.alwaysAvailable)
    .flatMap(modulePermissionNames));
/** Union of permission names granted by a set of enabled module keys. */
const permissionsForModules = (moduleKeys) => {
    const enabled = new Set(moduleKeys);
    return new Set(exports.MODULE_CATALOG
        .filter((moduleDef) => enabled.has(moduleDef.key))
        .flatMap(modulePermissionNames));
};
exports.permissionsForModules = permissionsForModules;
const sanitizeModuleKeys = (input) => Array.isArray(input)
    ? [...new Set(input.map(String))].filter((key) => exports.MODULE_KEYS.includes(key))
    : [];
exports.sanitizeModuleKeys = sanitizeModuleKeys;
//# sourceMappingURL=moduleCatalog.js.map