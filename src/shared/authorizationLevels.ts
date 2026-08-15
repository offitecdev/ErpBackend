import { MODULE_CATALOG } from './moduleCatalog';

/**
 * Stufenmodell der Berechtigungsseite (Einstellungen → Berechtigungen).
 *
 * Die Seite kennt GENAU SECHS Module (Vorgabe 14.08.2026): Kalender,
 * Personal, CRM, Projekte, Lager, Einstellungen — mehr nicht. Fakturierung
 * ist Teil des Projektmoduls (eine Projektstufe gewährt die Rechnungsrechte
 * gleich mit); Logistik/Wartung sind hier bewusst NICHT konfigurierbar.
 * Der Kalender gehört immer allen.
 *
 *   Stufe 0 = Modul aus → das Modul erscheint für die Person gar nicht
 *   Stufe 1 = ansehen        → read-Rechte der Gruppe
 *   Stufe 2 = bearbeiten     → read + write
 *   Stufe 3 = löschen        → read + write + delete
 *
 * Nicht jede Gruppe führt alle Ränge (CRM/Projekte haben kein delete): eine
 * Stufe gewährt, was es bis dahin GIBT.
 *
 * Der Personentyp (Rollenname) wird aus der Auswahl ABGELEITET:
 *   Montage (Techniker-Schalter) → Techniker (ausschliesslich)
 *   Einstellungen               → Manager
 *   CRM + Projekte              → Erweiterter Verkäufer
 *   CRM                         → Verkäufer
 *   sonst                       → Mitarbeiter
 *
 * VORSICHT bei den Namen: lib/access.ts (Frontend) erkennt Profile über
 * Teilzeichenketten im Rollennamen ('techniker' → Technikprofil) — "Techniker"
 * ist hier Absicht.
 */

export type AuthorizationLevel = 0 | 1 | 2 | 3;

/** Der Techniker-Schalter läuft über das fieldwork-Modul (Montage). */
export const TECHNICIAN_MODULE_KEY = 'fieldwork';
/** Immer im Paket — der Kalender steht allen offen. */
export const ALWAYS_ON_MODULE_KEYS = ['calendar'];

/**
 * Die wählbaren Gruppen der Seite → die Katalogmodule, die sie bündeln.
 * "projects" trägt die Fakturierung mit; alles andere ist 1:1.
 */
export const AUTH_MODULE_GROUPS: ReadonlyArray<{
    key: string;
    catalogKeys: string[];
    /** Höchste Stufe, die die Seite anbietet (3 nur mit delete-Rang). */
    maxLevel: AuthorizationLevel;
    /** Ein/Aus-Gruppe, die bei EIN auch die write-Rechte gewährt (Einstellungen:
        "Settings gewählt → Manager → Firmen-/Verwaltungsrechte offen"). */
    writeWhenOn?: boolean;
}> = [
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
    { key: TECHNICIAN_MODULE_KEY, catalogKeys: [TECHNICIAN_MODULE_KEY], maxLevel: 1 },
];

const groupByKey = new Map(AUTH_MODULE_GROUPS.map((group) => [group.key, group]));
const catalogByKey = new Map(MODULE_CATALOG.map((moduleDef) => [moduleDef.key, moduleDef]));

export const clampLevel = (raw: unknown): AuthorizationLevel => {
    const value = Math.trunc(Number(raw));
    if (value <= 0 || Number.isNaN(value)) return 0;
    return (value >= 3 ? 3 : value) as AuthorizationLevel;
};

/**
 * Eingehende Stufen bereinigen: nur bekannte Gruppen, und ein gesetzter
 * Techniker-Schalter räumt alles andere ab (die Technik-Oberfläche ersetzt
 * alle anderen Bildschirme).
 */
export const sanitizeModuleLevels = (raw: unknown): Record<string, AuthorizationLevel> => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const levels: Record<string, AuthorizationLevel> = {};
    for (const group of AUTH_MODULE_GROUPS) {
        const level = clampLevel(input[group.key]);
        if (level > 0) levels[group.key] = (level > group.maxLevel ? group.maxLevel : level) as AuthorizationLevel;
    }
    if (levels[TECHNICIAN_MODULE_KEY]) {
        const technicianLevel = levels[TECHNICIAN_MODULE_KEY];
        for (const key of Object.keys(levels)) delete levels[key];
        levels[TECHNICIAN_MODULE_KEY] = technicianLevel;
    }
    return levels;
};

/** Rechte, die eine Stufe in einer Gruppe gewährt (leere Ränge übersprungen). */
export const permissionsForLevel = (groupKey: string, level: AuthorizationLevel): string[] => {
    const group = groupByKey.get(groupKey);
    if (!group || level <= 0) return [];
    // Ein/Aus-Gruppen mit writeWhenOn gewähren bei EIN auch write — sie haben
    // keine eigene Bearbeiten-Stufe, "an" IST die Freischaltung.
    const effective = group.writeWhenOn && level >= 1 && level < 2 ? 2 : level;
    const names: string[] = [];
    for (const catalogKey of group.catalogKeys) {
        const moduleDef = catalogByKey.get(catalogKey);
        if (!moduleDef) continue;
        if (effective >= 1) names.push(...(moduleDef.actions.read ?? []));
        if (effective >= 2) names.push(...(moduleDef.actions.write ?? []));
        if (effective >= 3) names.push(...(moduleDef.actions.delete ?? []));
    }
    return names;
};

export const permissionsForLevels = (levels: Record<string, AuthorizationLevel>): string[] => {
    const names = new Set<string>();
    for (const [groupKey, level] of Object.entries(levels)) {
        for (const name of permissionsForLevel(groupKey, level)) names.add(name);
    }
    return [...names];
};

/**
 * Modulpaket (RoleModuleConfig.moduleKeys) aus der Auswahl: die Katalogmodule
 * aller gewählten Gruppen plus der Kalender. Nicht gewählte Gruppen fehlen —
 * "passt die Stufe nicht, sieht die Person das Modul schlicht nicht".
 */
export const packageKeysForLevels = (levels: Record<string, AuthorizationLevel>): string[] => {
    const keys = new Set<string>(ALWAYS_ON_MODULE_KEYS);
    for (const [groupKey, level] of Object.entries(levels)) {
        if (level <= 0) continue;
        for (const catalogKey of groupByKey.get(groupKey)?.catalogKeys ?? []) keys.add(catalogKey);
    }
    return [...keys].sort();
};

/** Personentyp aus der Auswahl — die Regeln aus dem Kopfkommentar. */
export const deriveRoleName = (levels: Record<string, AuthorizationLevel>): string => {
    const has = (key: string) => (levels[key] ?? 0) > 0;
    if (has(TECHNICIAN_MODULE_KEY)) return 'Techniker';
    if (has('settings')) return 'Manager';
    if (has('crm') && has('projects')) return 'Erweiterter Verkäufer';
    if (has('crm')) return 'Verkäufer';
    return 'Mitarbeiter';
};

/**
 * Umkehrung für die Anzeige: aus dem Rollenpaket und den Rechten einer
 * bestehenden Rolle wird je Gruppe die Stufe zurückgerechnet. Ein Rang zählt
 * als erreicht, wenn er nicht leer ist und vollständig in den Rechten steckt;
 * Gruppen ohne Ränge (Einstellungen, Techniker) stehen auf Stufe 1, sobald
 * ihr Schlüssel im Paket ist.
 */
export const levelsFromRole = (
    packageModuleKeys: string[],
    permissionNames: string[],
): Record<string, AuthorizationLevel> => {
    const owned = new Set(permissionNames);
    const inPackage = new Set(packageModuleKeys);
    const levels: Record<string, AuthorizationLevel> = {};
    for (const group of AUTH_MODULE_GROUPS) {
        // Die Gruppe gilt als gewählt, wenn ihr LEITMODUL im Paket steht.
        const leadKey = group.catalogKeys[0];
        if (!leadKey || !inPackage.has(leadKey)) continue;
        const tierNames = (tier: 'read' | 'write' | 'delete') =>
            group.catalogKeys.flatMap((catalogKey) => catalogByKey.get(catalogKey)?.actions[tier] ?? []);
        const tierComplete = (names: string[]) =>
            names.length > 0 && names.every((name) => owned.has(name));
        let level: AuthorizationLevel = 1;
        if (tierComplete(tierNames('write'))) level = 2;
        if (level === 2 && tierComplete(tierNames('delete'))) level = 3;
        // Nie über das hinaus, was die Seite anbietet (Ein/Aus-Gruppen → 1).
        levels[group.key] = (level > group.maxLevel ? group.maxLevel : level) as AuthorizationLevel;
    }
    return levels;
};
