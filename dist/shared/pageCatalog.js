"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminModuleKeys = exports.adminPermissionNames = exports.ADMIN_PAGE_LEVELS = exports.pageLevelsFromPermissions = exports.moduleKeysForPageLevels = exports.permissionsForPageLevels = exports.CATALOG_GRANTED_PERMISSION_NAMES = exports.permissionsForPage = exports.sanitizePageLevels = exports.RETIRED_PAGE_KEYS = exports.clampPageLevel = exports.getPage = exports.ALL_PAGES = exports.PAGE_MODULES = exports.ALWAYS_ON_MODULE_KEYS = void 0;
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
                /* ARBEITSZEITERFASSUNG (26.08.2026). Sie hat den Detail- und
                   den Buchhaltungsrapport abgelöst und trägt deren Rechte:
                   ansehen = attendance.read, ändern = eine Stempelung
                   korrigieren. Die Schichtplanung ist eine Einstellung
                   geworden und steht nicht mehr im Seitenkatalog. */
                key: 'personnel.timeRecords',
                path: '/personnel/time-records',
                labelKey: 'nav.personnelTimeRecords',
                maxLevel: 2,
                grants: { read: ['attendance.read'], write: ['attendance.create', 'attendance.update'] },
            },
            {
                /* DIE ANTRAGSSEITE, IN DREI ZEILEN (27.08.2026, Vorgabe):
                   «Meine Anträge», «Eingehende Anträge» und «Alle Anträge»
                   sind in der Rollentabelle EINZELN wählbar. Die Seite selbst
                   bleibt eine Adresse mit Reitern; die beiden Zusatzzeilen
                   tragen Unteradressen, die nie aufgerufen werden — sie sind
                   die Schalter, nicht die Wege.

                   «Meine Anträge» ist reine Sichtbarkeit: einen eigenen
                   Antrag stellen darf jede angemeldete Person, der Server
                   verlangt dafür kein Recht. */
                key: 'personnel.requests',
                path: '/personnel/requests',
                labelKey: 'nav.personnelRequestsMine',
                maxLevel: 1,
                grants: {},
            },
            {
                /* Das Postfach der freigebenden Personen. Stufe 2 trägt
                   `leaves.approve` — und genau daran hängt seit dem 27.08.2026
                   auch, WER als freigebende Person wählbar ist (Administrator-
                   oder z. B. Projektleiter-Rolle): die Personalrolle ADMIN ist
                   abgelöst. */
                key: 'personnel.requestsIncoming',
                path: '/personnel/requests/incoming',
                labelKey: 'nav.personnelRequestsIncoming',
                maxLevel: 2,
                grants: { write: ['leaves.approve'] },
            },
            {
                // Die Gesamtübersicht der Personalverwaltung.
                key: 'personnel.requestsAll',
                path: '/personnel/requests/all',
                labelKey: 'nav.personnelRequestsAll',
                maxLevel: 1,
                grants: { read: ['leaves.read'] },
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
            {
                // OSP (04.09.2026): Offertanfragen der Offitec Selection
                // Platform — Liste, Zuständigkeit, Import in eine Offerte.
                key: 'sales.osp',
                path: '/sales/osp',
                labelKey: 'nav.salesOsp',
                maxLevel: 2,
                grants: {
                    read: ['tenders.view'],
                    write: ['tenders.manage'],
                },
            },
            {
                // Rechnungsliste (30.08.2026): ALLE Rechnungen des Mandanten an
                // einer Stelle — Projektauftrag, Lieferauftrag und die selbst
                // ausgefüllte Direktrechnung. Löschen ist hier eine eigene Stufe:
                // eine stornierte Rechnung endgültig zu entfernen ist mehr, als
                // eine neue auszustellen.
                key: 'sales.invoices',
                path: '/sales/invoices',
                labelKey: 'nav.salesInvoices',
                maxLevel: 3,
                grants: {
                    read: ['billing.view', 'crm.customers.view'],
                    write: ['billing.create'],
                    delete: ['billing.manage'],
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
        // ── MONTAGE (Technikerarbeitsplatz) ─────────────────────────────────
        // Eigene Zeile, kein Anhängsel der Projektverwaltung: der Techniker
        // arbeitet AUSSCHLIESSLICH in /montage (eigene Termine, Rapporte,
        // Übergaben) und darf dafür nicht die ganze Projektliste des Büros
        // bekommen. Genau daran fehlte es bis 19.08.2026: `projects.report`
        // war nur über die Seite "Projektverwaltung" auf Stufe 2 zu haben, also
        // hatte eine hier gebaute Technikerrolle das Recht nie — jeder Aufruf
        // aus /montage lief in "Erisim Engellendi ... projects.report".
        //
        // Stufe 1 = die eigenen Montagen und Rapporte ANSEHEN, Stufe 2 = sie
        // ausfüllen, unterschreiben, abschliessen und Zusatzmaterial anfordern.
        // Die Technikerendpunkte sind auf die anfragende Person eingeschränkt,
        // darum genügt dort das Leserecht der Projekte.
        key: 'montage',
        labelKey: 'nav.montage',
        catalogKeys: ['projects'],
        pages: [
            {
                key: 'montage.workspace',
                path: '/montage',
                labelKey: 'nav.montageWorkspace',
                maxLevel: 2,
                grants: {
                    read: ['projects.view'],
                    // EIN Name (nicht mehr): so erkennt `pageLevelsFromPermissions`
                    // die Altrollen der Techniker (projects.view + projects.report)
                    // wieder als Stufe 2 statt sie auf "ansehen" zurückzusetzen.
                    write: ['projects.report'],
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
/**
 * ── ABGELÖSTE SEITENSCHLÜSSEL (26.08.2026) ──────────────────────────────────
 *
 * Wird eine Seite durch eine andere ersetzt, steht in den GESPEICHERTEN Rollen
 * weiterhin der alte Schlüssel. Ohne diese Karte fiele er beim Einlesen weg
 * (`sanitizePageLevels` kennt nur den Katalog) — und jede bestehende Rolle
 * verlöre die Seite, obwohl niemand ihr etwas weggenommen hat.
 *
 * Die Karte ist deshalb kein Notbehelf, sondern der Migrationsweg: der alte
 * Schlüssel gilt für den NEUEN weiter, bis die Rolle das nächste Mal
 * gespeichert wird — dann steht der neue drin und der alte verschwindet von
 * selbst. Mehrere alte Schlüssel auf denselben neuen: die HÖCHSTE Stufe
 * gewinnt, wie überall beim Zusammenlegen.
 */
exports.RETIRED_PAGE_KEYS = {
    // Detail- und Buchhaltungsrapport → Arbeitszeiterfassung.
    'personnel.reports': 'personnel.timeRecords',
    'personnel.accounting': 'personnel.timeRecords',
    // Anträge / Urlaubsanträge / Eingehende Anträge → die Antragsseite. Seit
    // dem 27.08.2026 ist sie in drei wählbare Zeilen geteilt: die eigenen
    // Anträge erben vom alten «Urlaubsanträge», das Postfach von den beiden
    // Eingangs-Seiten.
    'personnel.leaves': 'personnel.requests',
    'personnel.approvals': 'personnel.requestsIncoming',
    'personnel.incoming': 'personnel.requestsIncoming',
};
/** Die Stufe, die ein abgelöster Schlüssel dem neuen vererbt (0 = keine). */
const inheritedLevel = (input, pageKey, maxLevel) => {
    let best = 0;
    for (const [retired, successor] of Object.entries(exports.RETIRED_PAGE_KEYS)) {
        if (successor !== pageKey)
            continue;
        const level = (0, exports.clampPageLevel)(input[retired], maxLevel);
        if (level > best)
            best = level;
    }
    return best;
};
const sanitizePageLevels = (raw) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const levels = {};
    for (const page of exports.ALL_PAGES) {
        // Der eigene Schlüssel zuerst; fehlt er, erbt die Seite von ihren
        // Vorgängern. Steht beides drin, gewinnt der eigene — er ist der
        // jüngere Wille.
        const own = (0, exports.clampPageLevel)(input[page.key], page.maxLevel);
        const level = own > 0 || Object.prototype.hasOwnProperty.call(input, page.key)
            ? own
            : inheritedLevel(input, page.key, page.maxLevel);
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
/**
 * JEDER Rechtename, den dieser Katalog überhaupt vergeben kann. Beim Speichern
 * einer Rolle darf nur INNERHALB dieser Menge weggenommen werden: Rechte, für
 * die es keine Seitenzeile gibt (Wartung, Regie, Logistik, Arbeitsaufträge,
 * Verwaltung), stehen nicht in der Tabelle und dürfen deshalb auch nicht still
 * verschwinden, sobald jemand die Tabelle speichert.
 */
exports.CATALOG_GRANTED_PERMISSION_NAMES = new Set(exports.ALL_PAGES.flatMap((page) => [
    ...(page.grants.read ?? []),
    ...(page.grants.write ?? []),
    ...(page.grants.delete ?? []),
]));
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