/**
 * Checklisten / Formulare — Feldmodell (Server-Seite).
 *
 * Das Frontend spiegelt diese Datei in `offitec-frontend/src/lib/formFields.ts`
 * (Feldtypen, Bedingungsauswertung, Pflichtprüfung). Beide müssen im
 * Gleichschritt bleiben: der Server ist die Autorität, was gespeichert und
 * als "abgeschlossen" akzeptiert wird; die Oberfläche zeigt dieselben Fehler
 * vorher an, damit niemand am Server-Nein überrascht wird.
 */
import { nanoid } from 'nanoid';

export const FORM_FIELD_TYPES = [
    'TEXT',
    'NUMBER',
    'QUANTITY',
    'METERS',
    'KILOGRAMS',
    'CENTIMETERS',
    'MILLIMETERS',
    'CHECKBOX',
    'SELECT',
    'PHOTO',
    'FILE',
    'DRAWING',
    'SIGNATURE',
    'DATE',
    'SECTION',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Zahlenartige Typen: der Wert ist eine Zahl (oder null), das Suffix die Einheit. */
export const NUMERIC_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set([
    'NUMBER', 'QUANTITY', 'METERS', 'KILOGRAMS', 'CENTIMETERS', 'MILLIMETERS',
]);

export const CONDITION_OPERATORS = [
    'EQUALS',
    'NOT_EQUALS',
    'IS_CHECKED',
    'IS_NOT_CHECKED',
    'NOT_EMPTY',
    'EMPTY',
    'GREATER_THAN',
    'LESS_THAN',
] as const;
export type FormConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface FormCondition {
    fieldId: string;
    operator: FormConditionOperator;
    value?: string;
}

export interface FormFieldOption {
    id: string;
    label: string;
}

export interface FormFieldDef {
    id: string;
    type: FormFieldType;
    label: string;
    required?: boolean;
    placeholder?: string;
    help?: string;
    /** TEXT: mehrzeiliges Feld. */
    multiline?: boolean;
    /** SELECT: die Auswahlmöglichkeiten. */
    options?: FormFieldOption[];
    /** SELECT: Aufklappliste oder Optionsknöpfe. */
    display?: 'dropdown' | 'radio';
    /** Bedingung: nur sichtbar, wenn ein anderes Feld einen bestimmten Wert hat. */
    visibleWhen?: FormCondition | null;
}

export type FormValues = Record<string, unknown>;

const str = (value: unknown, max = 500): string => String(value ?? '').trim().slice(0, max);

/**
 * Bringt die Feldliste aus dem Vorlagen-Editor in die gespeicherte Form:
 * stabile Ids, gültige Typen, bereinigte Optionen und Bedingungen. Felder
 * ohne Beschriftung fliegen raus (Abschnitte brauchen eine, alle anderen auch),
 * Bedingungen auf unbekannte Felder werden gelöscht.
 */
export function normalizeFormFields(raw: unknown): FormFieldDef[] {
    if (!Array.isArray(raw)) return [];
    const fields: FormFieldDef[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item.type || 'TEXT').toUpperCase() as FormFieldType;
        if (!FORM_FIELD_TYPES.includes(type)) continue;
        const label = str(item.label, 300);
        if (!label) continue;
        const field: FormFieldDef = {
            id: str(item.id, 40) || nanoid(8),
            type,
            label,
        };
        if (item.required && type !== 'SECTION') field.required = true;
        const placeholder = str(item.placeholder, 200);
        if (placeholder) field.placeholder = placeholder;
        const help = str(item.help, 500);
        if (help) field.help = help;
        if (type === 'TEXT' && item.multiline) field.multiline = true;
        if (type === 'SELECT') {
            const options = Array.isArray(item.options) ? item.options : [];
            field.options = options
                .map((option: any) => ({
                    id: str(option?.id, 40) || nanoid(6),
                    label: str(option?.label, 200),
                }))
                .filter((option: FormFieldOption) => option.label.length > 0);
            field.display = item.display === 'radio' ? 'radio' : 'dropdown';
        }
        const condition = item.visibleWhen as Record<string, unknown> | null | undefined;
        if (condition && typeof condition === 'object') {
            const operator = String(condition.operator || '').toUpperCase() as FormConditionOperator;
            const fieldId = str(condition.fieldId, 40);
            if (fieldId && CONDITION_OPERATORS.includes(operator)) {
                field.visibleWhen = { fieldId, operator };
                const value = str(condition.value, 200);
                if (value) field.visibleWhen.value = value;
            }
        }
        fields.push(field);
    }
    // Ids eindeutig halten — ein doppeltes Einfügen im Editor darf keine zwei
    // Felder mit derselben Id hinterlassen (die Werte würden sich überschreiben).
    const seen = new Set<string>();
    for (const field of fields) {
        while (seen.has(field.id)) field.id = nanoid(8);
        seen.add(field.id);
    }
    // Bedingungen dürfen nur auf VORHER stehende, existierende Felder zeigen
    // (kein Feld kann von sich selbst oder von einem späteren Feld abhängen).
    const order = new Map(fields.map((field, index) => [field.id, index]));
    fields.forEach((field, index) => {
        const target = field.visibleWhen?.fieldId;
        if (!target) return;
        const targetIndex = order.get(target);
        if (targetIndex === undefined || targetIndex >= index) delete field.visibleWhen;
    });
    return fields;
}

// ── Werte ────────────────────────────────────────────────────────────────────

const isBlank = (value: unknown): boolean => {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (typeof value === 'number') return Number.isNaN(value);
    if (typeof value === 'boolean') return false;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') {
        const dataUrl = (value as Record<string, unknown>).dataUrl;
        return !(typeof dataUrl === 'string' && dataUrl.length > 0);
    }
    return false;
};

/** Leer im Sinne der Pflichtprüfung / Bedingung "ausgefüllt". */
export const isFormValueEmpty = (field: FormFieldDef, value: unknown): boolean => {
    if (field.type === 'CHECKBOX') return value !== true;
    return isBlank(value);
};

/** Wert eines Feldes als vergleichbarer Text (Bedingungen EQUALS/NOT_EQUALS). */
const comparable = (field: FormFieldDef, value: unknown): string => {
    if (field.type === 'CHECKBOX') return value === true ? 'true' : 'false';
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    return String(value).trim().toLowerCase();
};

const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

/**
 * Sichtbarkeit aller Felder: ein Feld ist sichtbar, wenn es keine Bedingung
 * hat ODER die Bedingung erfüllt ist UND das Bezugsfeld selbst sichtbar ist
 * (Ketten: "Kernbohrung? → Ja" blendet "Bohrdurchmesser" ein, das seinerseits
 * weitere Felder steuern kann). Ein Abschnitt hat keinen Wert; hängt eine
 * Bedingung an ihm, gilt sie als erfüllt, sobald der Abschnitt sichtbar ist.
 */
export function computeFieldVisibility(fields: FormFieldDef[], values: FormValues): Record<string, boolean> {
    const byId = new Map(fields.map((field) => [field.id, field]));
    const visible: Record<string, boolean> = {};
    for (const field of fields) {
        const condition = field.visibleWhen;
        if (!condition) { visible[field.id] = true; continue; }
        const source = byId.get(condition.fieldId);
        if (!source) { visible[field.id] = true; continue; }
        if (visible[source.id] === false) { visible[field.id] = false; continue; }
        if (source.type === 'SECTION') { visible[field.id] = true; continue; }
        const raw = values[source.id];
        const expected = String(condition.value ?? '').trim().toLowerCase();
        let ok: boolean;
        switch (condition.operator) {
            case 'EQUALS': ok = comparable(source, raw) === expected; break;
            case 'NOT_EQUALS': ok = comparable(source, raw) !== expected; break;
            case 'IS_CHECKED': ok = raw === true; break;
            case 'IS_NOT_CHECKED': ok = raw !== true; break;
            case 'NOT_EMPTY': ok = !isFormValueEmpty(source, raw); break;
            case 'EMPTY': ok = isFormValueEmpty(source, raw); break;
            case 'GREATER_THAN': {
                const left = asNumber(raw); const right = asNumber(expected);
                ok = left !== null && right !== null && left > right; break;
            }
            case 'LESS_THAN': {
                const left = asNumber(raw); const right = asNumber(expected);
                ok = left !== null && right !== null && left < right; break;
            }
            default: ok = true;
        }
        visible[field.id] = ok;
    }
    return visible;
}

/**
 * Bereinigt die Werte einer Abgabe: nur bekannte Feld-Ids, je Typ die
 * erwartete Form. Unbekannte Schlüssel und Werte falscher Form fallen weg —
 * lieber ein leeres Feld als ein Wert, den PDF und Bedingungen nicht lesen.
 */
export function sanitizeFormValues(fields: FormFieldDef[], raw: unknown): FormValues {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: FormValues = {};
    for (const field of fields) {
        const value = input[field.id];
        if (value === undefined || value === null) continue;
        switch (field.type) {
            case 'SECTION': break;
            case 'TEXT': {
                const text = String(value).slice(0, 20000);
                if (text.length) out[field.id] = text;
                break;
            }
            case 'DATE': {
                const text = String(value).trim().slice(0, 40);
                if (text) out[field.id] = text;
                break;
            }
            case 'NUMBER': case 'QUANTITY': case 'METERS': case 'KILOGRAMS': case 'CENTIMETERS': case 'MILLIMETERS': {
                const number = asNumber(value);
                if (number !== null) out[field.id] = number;
                break;
            }
            case 'CHECKBOX': out[field.id] = value === true || value === 'true'; break;
            case 'SELECT': {
                const id = String(value).trim();
                if (id && (field.options || []).some((option) => option.id === id)) out[field.id] = id;
                break;
            }
            case 'PHOTO': {
                if (!Array.isArray(value)) break;
                const photos = value
                    .map((photo: any) => (typeof photo === 'string' ? { dataUrl: photo } : photo))
                    .filter((photo: any) => photo && typeof photo.dataUrl === 'string' && photo.dataUrl.startsWith('data:image/'))
                    .slice(0, 30)
                    .map((photo: any) => ({ dataUrl: photo.dataUrl, ...(photo.caption ? { caption: str(photo.caption, 300) } : {}) }));
                if (photos.length) out[field.id] = photos;
                break;
            }
            case 'FILE': {
                if (!Array.isArray(value)) break;
                const files = value
                    .filter((file: any) => file && typeof file.dataUrl === 'string' && file.dataUrl.startsWith('data:'))
                    .slice(0, 20)
                    .map((file: any) => ({
                        name: str(file.name, 200) || 'file',
                        mimeType: str(file.mimeType, 120) || 'application/octet-stream',
                        size: Number(file.size) || 0,
                        dataUrl: file.dataUrl,
                    }));
                if (files.length) out[field.id] = files;
                break;
            }
            case 'DRAWING': {
                if (typeof value === 'string' && value.startsWith('data:image/')) out[field.id] = value;
                break;
            }
            case 'SIGNATURE': {
                const sig = typeof value === 'string' ? { dataUrl: value } : (value as Record<string, unknown>);
                if (sig && typeof sig.dataUrl === 'string' && sig.dataUrl.startsWith('data:image/')) {
                    out[field.id] = {
                        dataUrl: sig.dataUrl,
                        signedAt: typeof sig.signedAt === 'string' && sig.signedAt ? sig.signedAt : new Date().toISOString(),
                        ...(sig.name ? { name: str(sig.name, 200) } : {}),
                    };
                }
                break;
            }
            default: break;
        }
    }
    return out;
}

/** Ids der SICHTBAREN Pflichtfelder ohne Wert — leer = abschliessbar. */
export function missingRequiredFields(fields: FormFieldDef[], values: FormValues): string[] {
    const visible = computeFieldVisibility(fields, values);
    return fields
        .filter((field) => field.type !== 'SECTION' && field.required && visible[field.id] !== false)
        .filter((field) => isFormValueEmpty(field, values[field.id]))
        .map((field) => field.id);
}
