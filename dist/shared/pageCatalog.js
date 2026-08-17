"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminModuleKeys = exports.adminPermissionNames = exports.ADMIN_PAGE_LEVELS = exports.pageLevelsFromPermissions = exports.moduleKeysForPageLevels = exports.permissionsForPageLevels = exports.permissionsForPage = exports.sanitizePageLevels = exports.clampPageLevel = exports.getPage = exports.ALL_PAGES = exports.PAGE_MODULES = exports.ALWAYS_ON_MODULE_KEYS = void 0;
const moduleCatalog_1 = require("./moduleCatalog");
/** Immer im Paket — der Kalender steht allen offen (wie bisher). */
exports.ALWAYS_ON_MODULE_KEYS = ['calendar'];
exports.PAGE_MODULES = [
    {
        key: 'personnel',
        labelKey: 'nav.personnel',
        catalogKeys: ['personnel'],
        pages: [
            {
                key: 'personnel.list',
                path: '/personnel',
                labelKey: 'nav.personnelList',
                maxLevel: 3,
                grants: {
                    read: ['employees.view'],
                    write: ['employees.create', 'employees.update'],
                    delete: ['employees.delete'],
                },
            },
            {
                // Die Stempeluhr steht am Tablet: gestempelt wird ohnehin nur mit
                // gültigem QR-Ausweis, hier geht es allein um die Sichtbarkeit.
                key: 'personnel.terminal',
                path: '/personnel/terminal',
                labelKey: 'nav.personnelTerminal',
                maxLevel: 1,
                grants: {},
            },
            {
                key: 'personnel.shiftPlan',
                path: '/personnel/shift-plan',
                labelKey: 'nav.personnelShiftPlan',
                maxLevel: 2,
                grants: { read: ['attendance.read'], write: ['attendance.update'] },
            },
            {
                key: 'personnel.reports',
                path: '/personnel/reports',
                labelKey: 'nav.personnelDetailedReport',
                maxLevel: 2,
                grants: { read: ['attendance.read'], write: ['attendance.create', 'attendance.update'] },
            },
            {
                key: 'personnel.accounting',
                path: '/personnel/accounting',
                labelKey: 'nav.personnelAccounting',
                maxLevel: 1,
                grants: { read: ['attendance.read'] },
            },
            {
                key: 'personnel.leaves',
                path: '/personnel/leaves',
                labelKey: 'nav.personnelLeaves',
                maxLevel: 3,
                grants: { read: ['leaves.read'], write: ['leaves.create'], delete: ['leaves.delete'] },
            },
            {
                key: 'personnel.approvals',
                path: '/personnel/approvals',
                labelKey: 'nav.personnelApprovals',
                maxLevel: 2,
                grants: { read: ['leaves.read'], write: ['leaves.approve'] },
            },
            {
                key: 'personnel.incoming',
                path: '/personnel/incoming',
                labelKey: 'nav.personnelIncoming',
                maxLevel: 2,
                grants: { read: ['leaves.read'], write: ['leaves.approve'] },
            },
        ],
    },
    {
        key: 'crm',
        labelKey: 'nav.crm',
        catalogKeys: ['crm'],
        pages: [
            {
                key: 'crm.customers',
                path: '/crm/customers',
                labelKey: 'nav.customerList',
                maxLevel: 2,
                grants: {
                    read: ['crm.customers.view'],
                    write: ['crm.customers.create', 'crm.customers.addNote', 'crm.documents.upload'],
                },
            },
            {
                key: 'crm.contacts',
                path: '/crm/contacts',
                labelKey: 'nav.crmContacts',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['crm.customers.create'] },
            },
            {
                key: 'crm.communication',
                path: '/crm/communication',
                labelKey: 'nav.crmCommunication',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['crm.activities.create'] },
            },
            {
                key: 'crm.tasks',
                path: '/crm/tasks',
                labelKey: 'nav.crmTasks',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['crm.activities.create'] },
            },
            {
                key: 'crm.reminders',
                path: '/crm/reminders',
                labelKey: 'nav.crmReminders',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['crm.activities.create'] },
            },
            {
                key: 'crm.quickEntry',
                path: '/crm/quick-entry',
                labelKey: 'nav.crmQuickEntry',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['crm.activities.create'] },
            },
            {
                key: 'crm.forms',
                path: '/crm/forms',
                labelKey: 'nav.crmForms',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['crm.activities.create'] },
            },
        ],
    },
    {
        key: 'sales',
        labelKey: 'nav.sales',
        // Verkauf lebt weiter im crm-Modulschlüssel (Umbau 14.08.2026); die
        // Fakturierung hängt an den Aufträgen.
        catalogKeys: ['crm', 'billing'],
        pages: [
            {
                key: 'sales.quotes',
                path: '/sales/quotes',
                labelKey: 'nav.tenderManagement',
                maxLevel: 2,
                grants: {
                    read: ['tenders.view'],
                    write: [
                        'tenders.create', 'tenders.update', 'tenders.manage', 'tenders.calculate',
                        'tenders.import', 'tenders.export', 'tenders.approve',
                    ],
                },
            },
            {
                key: 'sales.orders',
                path: '/sales/orders',
                labelKey: 'nav.myOrders',
                maxLevel: 2,
                grants: {
                    read: ['tenders.view', 'crm.customers.view', 'billing.view'],
                    write: ['tenders.manage', 'billing.create', 'billing.manage'],
                },
            },
        ],
    },
    {
        key: 'projects',
        labelKey: 'nav.projects',
        catalogKeys: ['projects', 'billing'],
        pages: [
            {
                key: 'projects.list',
                path: '/projects',
                labelKey: 'nav.projectManagement',
                maxLevel: 2,
                grants: {
                    read: ['projects.view'],
                    write: [
                        'projects.create', 'projects.manage', 'projects.approve', 'projects.report',
                        'projects.createAddonOrder', 'projects.approveVariation', 'projects.bookings.manage',
                        'projects.mail', 'mail.manage', 'mail.send',
                    ],
                },
            },
        ],
    },
    {
        key: 'inventory',
        labelKey: 'nav.inventory',
        catalogKeys: ['inventory'],
        pages: [
            {
                key: 'inventory.articles',
                path: '/inventory/articles',
                labelKey: 'nav.articles',
                maxLevel: 3,
                grants: {
                    read: ['inventory.view'],
                    write: ['inventory.articles.create', 'inventory.articles.update'],
                    delete: ['inventory.articles.delete'],
                },
            },
            {
                key: 'inventory.stock',
                path: '/inventory/stock',
                labelKey: 'nav.stock',
                maxLevel: 2,
                grants: { read: ['inventory.view'], write: ['inventory.manage', 'inventory.transfer'] },
            },
            {
                key: 'inventory.orders',
                path: '/inventory/orders',
                labelKey: 'nav.inventoryOrders',
                maxLevel: 2,
                grants: { read: ['inventory.view'], write: ['inventory.proposals.manage', 'inventory.manage'] },
            },
            {
                key: 'inventory.suppliers',
                path: '/inventory/suppliers',
                labelKey: 'nav.suppliers',
                maxLevel: 2,
                grants: { read: ['inventory.view'], write: ['inventory.manage'] },
            },
        ],
    },
];
exports.ALL_PAGES = exports.PAGE_MODULES.flatMap((moduleDef) => moduleDef.pages);
const pageByKey = new Map(exports.ALL_PAGES.map((page) => [page.key, page]));
const moduleByPageKey = new Map(exports.PAGE_MODULES.flatMap((moduleDef) => moduleDef.pages.map((page) => [page.key, moduleDef])));
const getPage = (key) => pageByKey.get(key);
exports.getPage = getPage;
const clampPageLevel = (raw, maxLevel = 3) => {
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return (value > maxLevel ? maxLevel : value);
};
exports.clampPageLevel = clampPageLevel;
/** Eingehende Stufen bereinigen: nur bekannte Seiten, nie über `maxLevel`. */
const sanitizePageLevels = (raw) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const levels = {};
    for (const page of exports.ALL_PAGES) {
        const level = (0, exports.clampPageLevel)(input[page.key], page.maxLevel);
        if (level > 0)
            levels[page.key] = level;
    }
    return levels;
};
exports.sanitizePageLevels = sanitizePageLevels;
/** Rechte EINER Seite auf einer Stufe (leere Ränge werden übersprungen). */
const permissionsForPage = (pageKey, level) => {
    const page = pageByKey.get(pageKey);
    if (!page || level <= 0)
        return [];
    const names = [];
    if (level >= 1)
        names.push(...(page.grants.read ?? []));
    if (level >= 2)
        names.push(...(page.grants.write ?? []));
    if (level >= 3)
        names.push(...(page.grants.delete ?? []));
    return names;
};
exports.permissionsForPage = permissionsForPage;
/** Die vollständige Rechtemenge einer Stufenkarte. */
const permissionsForPageLevels = (levels) => {
    const names = new Set();
    for (const [pageKey, level] of Object.entries(levels)) {
        for (const name of (0, exports.permissionsForPage)(pageKey, level))
            names.add(name);
    }
    return [...names];
};
exports.permissionsForPageLevels = permissionsForPageLevels;
/**
 * Modulpaket (RoleModuleConfig.moduleKeys) aus der Stufenkarte: die
 * Katalogmodule jedes Moduls, in dem MINDESTENS eine Seite gewählt ist, plus
 * der Kalender. Ohne den Schlüssel im Paket blendet das Menü das Modul aus.
 */
const moduleKeysForPageLevels = (levels) => {
    const keys = new Set(exports.ALWAYS_ON_MODULE_KEYS);
    for (const [pageKey, level] of Object.entries(levels)) {
        if (level <= 0)
            continue;
        for (const catalogKey of moduleByPageKey.get(pageKey)?.catalogKeys ?? [])
            keys.add(catalogKey);
    }
    return [...keys].sort();
};
exports.moduleKeysForPageLevels = moduleKeysForPageLevels;
/**
 * ALTBESTAND: Rollen aus der abgelösten Stufenseite tragen keine `pageLevels`.
 * Damit nach dem Aufspielen niemand vor einem leeren Menü steht, wird ihre
 * Stufenkarte aus den vorhandenen Rechten ZURÜCKGERECHNET — ein Rang zählt als
 * erreicht, wenn er nicht leer ist und vollständig in den Rechten steckt.
 * Seiten ganz ohne Rechte (Stempeluhr) folgen ihrem Modul: sie stehen offen,
 * sobald irgendeine Seite desselben Moduls erreicht ist.
 */
const pageLevelsFromPermissions = (permissionNames) => {
    const owned = new Set(permissionNames);
    const levels = {};
    const tierComplete = (names) => Array.isArray(names) && names.length > 0 && names.every((name) => owned.has(name));
    for (const page of exports.ALL_PAGES) {
        if (!tierComplete(page.grants.read))
            continue;
        let level = 1;
        if (tierComplete(page.grants.write))
            level = 2;
        if (level === 2 && tierComplete(page.grants.delete))
            level = 3;
        levels[page.key] = (level > page.maxLevel ? page.maxLevel : level);
    }
    // Rechtelose Seiten (nur Sichtbarkeit) an ihr Modul hängen.
    for (const moduleDef of exports.PAGE_MODULES) {
        const moduleReached = moduleDef.pages.some((page) => (levels[page.key] ?? 0) > 0);
        if (!moduleReached)
            continue;
        for (const page of moduleDef.pages) {
            const hasGrants = Object.values(page.grants).some((names) => (names ?? []).length > 0);
            if (!hasGrants && !levels[page.key])
                levels[page.key] = 1;
        }
    }
    return levels;
};
exports.pageLevelsFromPermissions = pageLevelsFromPermissions;
/** Die feste Administratorrolle: JEDE Seite auf ihrer höchsten Stufe. */
exports.ADMIN_PAGE_LEVELS = Object.fromEntries(exports.ALL_PAGES.map((page) => [page.key, page.maxLevel]));
/**
 * Rechte der Administratorrolle: alles aus dem Seitenkatalog PLUS die
 * Verwaltungsrechte (roles.manage, users.manage, tenants.*) und die restlichen
 * Katalogmodule, die der Seitenkatalog nicht führt (Logistik, Wartung). Der
 * IT-Bereich bleibt aussen vor — er hängt nicht an einem Recht, sondern an
 * einem eigenen Kennwort (settingsGate.routes.ts), und das gibt eine Rolle
 * nicht her.
 */
const adminPermissionNames = () => {
    const names = new Set((0, exports.permissionsForPageLevels)(exports.ADMIN_PAGE_LEVELS));
    for (const moduleDef of moduleCatalog_1.MODULE_CATALOG) {
        for (const tier of Object.values(moduleDef.actions)) {
            for (const name of tier ?? [])
                names.add(name);
        }
    }
    return [...names];
};
exports.adminPermissionNames = adminPermissionNames;
/** Modulpaket der Administratorrolle: jedes Katalogmodul. */
const adminModuleKeys = () => moduleCatalog_1.MODULE_CATALOG.map((moduleDef) => moduleDef.key).sort();
exports.adminModuleKeys = adminModuleKeys;
//# sourceMappingURL=pageCatalog.js.map