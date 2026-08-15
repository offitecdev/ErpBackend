"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.levelsFromRole = exports.deriveRoleName = exports.packageKeysForLevels = exports.permissionsForLevels = exports.permissionsForLevel = exports.sanitizeModuleLevels = exports.clampLevel = exports.AUTH_MODULE_GROUPS = exports.ALWAYS_ON_MODULE_KEYS = exports.TECHNICIAN_MODULE_KEY = void 0;
const moduleCatalog_1 = require("./moduleCatalog");
/** Der Techniker-Schalter läuft über das fieldwork-Modul (Montage). */
exports.TECHNICIAN_MODULE_KEY = 'fieldwork';
/** Immer im Paket — der Kalender steht allen offen. */
exports.ALWAYS_ON_MODULE_KEYS = ['calendar'];
/**
 * Die wählbaren Gruppen der Seite → die Katalogmodule, die sie bündeln.
 * "projects" trägt die Fakturierung mit; alles andere ist 1:1.
 */
exports.AUTH_MODULE_GROUPS = [
    { key: 'personnel', catalogKeys: ['personnel'], maxLevel: 3 },
    { key: 'crm', catalogKeys: ['crm'], maxLevel: 2 },
    { key: 'projects', catalogKeys: ['projects', 'billing'], maxLevel: 2 },
    { key: 'inventory', catalogKeys: ['inventory'], maxLevel: 3 },
    // Einstellungen trägt die VERWALTUNG mit (roles.manage, users.manage,
    // tenants.*): "Settings gewählt → Manager" heisst laut Vorgabe, dass
    // Firmen- und E-Mail-Einstellungen offen stehen. Ohne diese Kopplung
    // ENTZOG das Speichern einem Admin die Verwaltungsrechte — genau so hat
    // sich am 14.08.2026 ein Admin selbst ausgesperrt.
    { key: 'settings', catalogKeys: ['settings', 'administration'], maxLevel: 1, writeWhenOn: true },
    // Der Techniker-Schalter — eigene Gruppe, in der Oberfläche gesondert.
    { key: exports.TECHNICIAN_MODULE_KEY, catalogKeys: [exports.TECHNICIAN_MODULE_KEY], maxLevel: 1 },
];
const groupByKey = new Map(exports.AUTH_MODULE_GROUPS.map((group) => [group.key, group]));
const catalogByKey = new Map(moduleCatalog_1.MODULE_CATALOG.map((moduleDef) => [moduleDef.key, moduleDef]));
const clampLevel = (raw) => {
    const value = Math.trunc(Number(raw));
    if (value <= 0 || Number.isNaN(value))
        return 0;
    return (value >= 3 ? 3 : value);
};
exports.clampLevel = clampLevel;
/**
 * Eingehende Stufen bereinigen: nur bekannte Gruppen, und ein gesetzter
 * Techniker-Schalter räumt alles andere ab (die Technik-Oberfläche ersetzt
 * alle anderen Bildschirme).
 */
const sanitizeModuleLevels = (raw) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const levels = {};
    for (const group of exports.AUTH_MODULE_GROUPS) {
        const level = (0, exports.clampLevel)(input[group.key]);
        if (level > 0)
            levels[group.key] = (level > group.maxLevel ? group.maxLevel : level);
    }
    if (levels[exports.TECHNICIAN_MODULE_KEY]) {
        const technicianLevel = levels[exports.TECHNICIAN_MODULE_KEY];
        for (const key of Object.keys(levels))
            delete levels[key];
        levels[exports.TECHNICIAN_MODULE_KEY] = technicianLevel;
    }
    return levels;
};
exports.sanitizeModuleLevels = sanitizeModuleLevels;
/** Rechte, die eine Stufe in einer Gruppe gewährt (leere Ränge übersprungen). */
const permissionsForLevel = (groupKey, level) => {
    const group = groupByKey.get(groupKey);
    if (!group || level <= 0)
        return [];
    // Ein/Aus-Gruppen mit writeWhenOn gewähren bei EIN auch write — sie haben
    // keine eigene Bearbeiten-Stufe, "an" IST die Freischaltung.
    const effective = group.writeWhenOn && level >= 1 && level < 2 ? 2 : level;
    const names = [];
    for (const catalogKey of group.catalogKeys) {
        const moduleDef = catalogByKey.get(catalogKey);
        if (!moduleDef)
            continue;
        if (effective >= 1)
            names.push(...(moduleDef.actions.read ?? []));
        if (effective >= 2)
            names.push(...(moduleDef.actions.write ?? []));
        if (effective >= 3)
            names.push(...(moduleDef.actions.delete ?? []));
    }
    return names;
};
exports.permissionsForLevel = permissionsForLevel;
const permissionsForLevels = (levels) => {
    const names = new Set();
    for (const [groupKey, level] of Object.entries(levels)) {
        for (const name of (0, exports.permissionsForLevel)(groupKey, level))
            names.add(name);
    }
    return [...names];
};
exports.permissionsForLevels = permissionsForLevels;
/**
 * Modulpaket (RoleModuleConfig.moduleKeys) aus der Auswahl: die Katalogmodule
 * aller gewählten Gruppen plus der Kalender. Nicht gewählte Gruppen fehlen —
 * "passt die Stufe nicht, sieht die Person das Modul schlicht nicht".
 */
const packageKeysForLevels = (levels) => {
    const keys = new Set(exports.ALWAYS_ON_MODULE_KEYS);
    for (const [groupKey, level] of Object.entries(levels)) {
        if (level <= 0)
            continue;
        for (const catalogKey of groupByKey.get(groupKey)?.catalogKeys ?? [])
            keys.add(catalogKey);
    }
    return [...keys].sort();
};
exports.packageKeysForLevels = packageKeysForLevels;
/** Personentyp aus der Auswahl — die Regeln aus dem Kopfkommentar. */
const deriveRoleName = (levels) => {
    const has = (key) => (levels[key] ?? 0) > 0;
    if (has(exports.TECHNICIAN_MODULE_KEY))
        return 'Techniker';
    if (has('settings'))
        return 'Manager';
    if (has('crm') && has('projects'))
        return 'Erweiterter Verkäufer';
    if (has('crm'))
        return 'Verkäufer';
    return 'Mitarbeiter';
};
exports.deriveRoleName = deriveRoleName;
/**
 * Umkehrung für die Anzeige: aus dem Rollenpaket und den Rechten einer
 * bestehenden Rolle wird je Gruppe die Stufe zurückgerechnet. Ein Rang zählt
 * als erreicht, wenn er nicht leer ist und vollständig in den Rechten steckt;
 * Gruppen ohne Ränge (Einstellungen, Techniker) stehen auf Stufe 1, sobald
 * ihr Schlüssel im Paket ist.
 */
const levelsFromRole = (packageModuleKeys, permissionNames) => {
    const owned = new Set(permissionNames);
    const inPackage = new Set(packageModuleKeys);
    const levels = {};
    for (const group of exports.AUTH_MODULE_GROUPS) {
        // Die Gruppe gilt als gewählt, wenn ihr LEITMODUL im Paket steht.
        const leadKey = group.catalogKeys[0];
        if (!leadKey || !inPackage.has(leadKey))
            continue;
        const tierNames = (tier) => group.catalogKeys.flatMap((catalogKey) => catalogByKey.get(catalogKey)?.actions[tier] ?? []);
        const tierComplete = (names) => names.length > 0 && names.every((name) => owned.has(name));
        let level = 1;
        if (tierComplete(tierNames('write')))
            level = 2;
        if (level === 2 && tierComplete(tierNames('delete')))
            level = 3;
        // Nie über das hinaus, was die Seite anbietet (Ein/Aus-Gruppen → 1).
        levels[group.key] = (level > group.maxLevel ? group.maxLevel : level);
    }
    return levels;
};
exports.levelsFromRole = levelsFromRole;
//# sourceMappingURL=authorizationLevels.js.map