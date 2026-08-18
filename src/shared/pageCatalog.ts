import { MODULE_CATALOG } from './moduleCatalog';

/**
 * ── SEITENKATALOG (Rollenvorlagen, 17.08.2026) ───────────────────────────────
 *
 * Die Berechtigungstabelle einer Rolle steht MODUL für MODUL und SEITE für
 * SEITE (Vorgabe): fünf aktive Module — Personal, CRM, Verkauf, Projekte,
 * Lager — und darunter die einzelnen Seiten, jede mit EINER Stufe:
 *
 *   Stufe 0 = kein Zugriff  → die Seite erscheint für die Rolle gar nicht
 *   Stufe 1 = ansehen       → read
 *   Stufe 2 = bearbeiten    → read + write
 *   Stufe 3 = löschen       → read + write + delete
 *
 * Nicht jede Seite führt alle drei Ränge (eine Auswertung kennt kein Löschen);
 * `maxLevel` sagt, was die Tabelle für diese Seite überhaupt anbietet, und eine
 * Stufe gewährt, was es bis dahin GIBT.
 *
 * ── Warum ein eigener Katalog neben `moduleCatalog.ts` ──
 * Der Modulkatalog bündelt die flachen Rechtezeichenketten zu Modulen; er ist
 * weiterhin die Autorität dafür, was eine Firmenkategorie überhaupt freischalten
 * darf. DIESER Katalog ist eine Ebene feiner: er verteilt dieselben Rechte auf
 * die einzelnen Seiten. Beim Speichern einer Rolle werden aus den Seitenstufen
 * die RolePermission-Zeilen ABGELEITET — jede bestehende `requirePermission`-
 * Prüfung im Server arbeitet unverändert weiter.
 *
 * ── Grenze, die man kennen muss ──
 * Mehrere Seiten teilen sich dieselbe Rechtezeichenkette (alle CRM-Seiten lesen
 * über `crm.customers.view`). Auf ENDPUNKT-Ebene ist die Trennung deshalb so
 * grob wie die Rechtenamen; die SEITEN-Trennung selbst wird über `pageAccess`
 * durchgesetzt: der Server liefert die Stufenkarte mit, Menü und Seitenwächter
 * lassen nur durch, was darin steht.
 *
 * Das Frontend spiegelt diese Datei (src/lib/pageCatalog.ts) — Schlüssel,
 * Pfade und Stufen müssen in beiden Kopien gleich bleiben.
 */

export type PageLevel = 0 | 1 | 2 | 3;

export interface PageDefinition {
    /** Stabiler Schlüssel der Zeile — steht so in `Role.pageLevels`. */
    key: string;
    /** Die Adresse, die der Seitenwächter im Frontend abgleicht. */
    path: string;
    /** i18n-Schlüssel der Beschriftung (die Menübeschriftungen, wiederverwendet). */
    labelKey: string;
    /** Höchste Stufe, die die Tabelle für diese Seite anbietet. */
    maxLevel: PageLevel;
    /** Rechte, die die Ränge dieser Seite gewähren. */
    grants: { read?: string[]; write?: string[]; delete?: string[] };
}

export interface PageModuleDefinition {
    key: string;
    labelKey: string;
    /** Katalogmodule, die freigeschaltet werden, sobald EINE Seite gewählt ist. */
    catalogKeys: string[];
    pages: PageDefinition[];
}

/** Immer im Paket — der Kalender steht allen offen (wie bisher). */
export const ALWAYS_ON_MODULE_KEYS = ['calendar'];

export const PAGE_MODULES: ReadonlyArray<PageModuleDefinition> = [
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
                // E-Mail / Outlook-Postfach (17.08.2026): lesen = CRM-Recht,
                // schreiben = senden.
                key: 'crm.mail',
                path: '/crm/mail',
                labelKey: 'nav.crmMail',
                maxLevel: 2,
                grants: { read: ['crm.customers.view'], write: ['mail.send'] },
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

export const ALL_PAGES: ReadonlyArray<PageDefinition> = PAGE_MODULES.flatMap((moduleDef) => moduleDef.pages);

const pageByKey = new Map(ALL_PAGES.map((page) => [page.key, page]));
const moduleByPageKey = new Map(
    PAGE_MODULES.flatMap((moduleDef) => moduleDef.pages.map((page) => [page.key, moduleDef] as const)),
);

export const getPage = (key: string): PageDefinition | undefined => pageByKey.get(key);

export const clampPageLevel = (raw: unknown, maxLevel: PageLevel = 3): PageLevel => {
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return (value > maxLevel ? maxLevel : value) as PageLevel;
};

/** Eingehende Stufen bereinigen: nur bekannte Seiten, nie über `maxLevel`. */
export const sanitizePageLevels = (raw: unknown): Record<string, PageLevel> => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const levels: Record<string, PageLevel> = {};
    for (const page of ALL_PAGES) {
        const level = clampPageLevel(input[page.key], page.maxLevel);
        if (level > 0) levels[page.key] = level;
    }
    return levels;
};

/** Rechte EINER Seite auf einer Stufe (leere Ränge werden übersprungen). */
export const permissionsForPage = (pageKey: string, level: PageLevel): string[] => {
    const page = pageByKey.get(pageKey);
    if (!page || level <= 0) return [];
    const names: string[] = [];
    if (level >= 1) names.push(...(page.grants.read ?? []));
    if (level >= 2) names.push(...(page.grants.write ?? []));
    if (level >= 3) names.push(...(page.grants.delete ?? []));
    return names;
};

/** Die vollständige Rechtemenge einer Stufenkarte. */
export const permissionsForPageLevels = (levels: Record<string, PageLevel>): string[] => {
    const names = new Set<string>();
    for (const [pageKey, level] of Object.entries(levels)) {
        for (const name of permissionsForPage(pageKey, level)) names.add(name);
    }
    return [...names];
};

/**
 * Modulpaket (RoleModuleConfig.moduleKeys) aus der Stufenkarte: die
 * Katalogmodule jedes Moduls, in dem MINDESTENS eine Seite gewählt ist, plus
 * der Kalender. Ohne den Schlüssel im Paket blendet das Menü das Modul aus.
 */
export const moduleKeysForPageLevels = (levels: Record<string, PageLevel>): string[] => {
    const keys = new Set<string>(ALWAYS_ON_MODULE_KEYS);
    for (const [pageKey, level] of Object.entries(levels)) {
        if (level <= 0) continue;
        for (const catalogKey of moduleByPageKey.get(pageKey)?.catalogKeys ?? []) keys.add(catalogKey);
    }
    return [...keys].sort();
};

/**
 * ALTBESTAND: Rollen aus der abgelösten Stufenseite tragen keine `pageLevels`.
 * Damit nach dem Aufspielen niemand vor einem leeren Menü steht, wird ihre
 * Stufenkarte aus den vorhandenen Rechten ZURÜCKGERECHNET — ein Rang zählt als
 * erreicht, wenn er nicht leer ist und vollständig in den Rechten steckt.
 * Seiten ganz ohne Rechte (Stempeluhr) folgen ihrem Modul: sie stehen offen,
 * sobald irgendeine Seite desselben Moduls erreicht ist.
 */
export const pageLevelsFromPermissions = (permissionNames: string[]): Record<string, PageLevel> => {
    const owned = new Set(permissionNames);
    const levels: Record<string, PageLevel> = {};
    const tierComplete = (names: string[] | undefined) =>
        Array.isArray(names) && names.length > 0 && names.every((name) => owned.has(name));

    for (const page of ALL_PAGES) {
        if (!tierComplete(page.grants.read)) continue;
        let level: PageLevel = 1;
        if (tierComplete(page.grants.write)) level = 2;
        if (level === 2 && tierComplete(page.grants.delete)) level = 3;
        levels[page.key] = (level > page.maxLevel ? page.maxLevel : level) as PageLevel;
    }

    // Rechtelose Seiten (nur Sichtbarkeit) an ihr Modul hängen.
    for (const moduleDef of PAGE_MODULES) {
        const moduleReached = moduleDef.pages.some((page) => (levels[page.key] ?? 0) > 0);
        if (!moduleReached) continue;
        for (const page of moduleDef.pages) {
            const hasGrants = Object.values(page.grants).some((names) => (names ?? []).length > 0);
            if (!hasGrants && !levels[page.key]) levels[page.key] = 1;
        }
    }
    return levels;
};

/** Die feste Administratorrolle: JEDE Seite auf ihrer höchsten Stufe. */
export const ADMIN_PAGE_LEVELS: Record<string, PageLevel> = Object.fromEntries(
    ALL_PAGES.map((page) => [page.key, page.maxLevel]),
);

/**
 * Rechte der Administratorrolle: alles aus dem Seitenkatalog PLUS die
 * Verwaltungsrechte (roles.manage, users.manage, tenants.*) und die restlichen
 * Katalogmodule, die der Seitenkatalog nicht führt (Logistik, Wartung). Der
 * IT-Bereich bleibt aussen vor — er hängt nicht an einem Recht, sondern an
 * einem eigenen Kennwort (settingsGate.routes.ts), und das gibt eine Rolle
 * nicht her.
 */
export const adminPermissionNames = (): string[] => {
    const names = new Set(permissionsForPageLevels(ADMIN_PAGE_LEVELS));
    for (const moduleDef of MODULE_CATALOG) {
        for (const tier of Object.values(moduleDef.actions)) {
            for (const name of tier ?? []) names.add(name);
        }
    }
    return [...names];
};

/** Modulpaket der Administratorrolle: jedes Katalogmodul. */
export const adminModuleKeys = (): string[] => MODULE_CATALOG.map((moduleDef) => moduleDef.key).sort();
