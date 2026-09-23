import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { findTenantRootIdCached } from '../../shared/tenantTree';
import { issueCodes } from './articleCodeCatalog';
import {
    formatPanelModelNumber,
    normalizePanelCode,
    isValidFamilyCode,
    isValidVariantCode,
    ratingUnitLabel,
    variantRequiredReasons,
    type PanelVariantRules,
} from '../../shared/panelModelNumber';
import { nextPanelSerials, type PanelSerialOptions } from '../../shared/panelSerial';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';

/* ── SCHALTSCHRÄNKE: KATALOG UND SERIEN (20.09.2026, Vorgabe Baris) ──────────
 *
 * Drei Ebenen, drei Zuständigkeiten:
 *
 *   EINSTELLUNGEN   `uretim_pano_ayarlari` — die acht Entscheidungen aus der
 *                   Abstimmung. Kommt eine Antwort, ändert sich ein Feld.
 *   TYPENFAMILIE    `uretim_pano_tipleri` — der Katalog, aus dem die
 *                   Modellnummer ihren mittleren Teil nimmt (CP, DB, MCC …).
 *   MODELL          `uretim_pano_modelleri` — eine Produktkarte plus die
 *                   Typenschildwerte, die auf jedem Schrank dieses Typs
 *                   gleich sind. Die Modellnummer wird GEBILDET.
 *   SCHRANK         `uretim_pano_seri` — ein gebautes Stück mit Seriennummer.
 *
 * Was hier NICHT passiert: Lagerbuchungen. Ein Schrank kommt mit einer
 * gewöhnlichen `IN`-Bewegung über seine Produktkarte ins Lager (Menge 1,
 * `StockMovement.serialNumber` = seine Seriennummer) — dieselbe Mechanik wie
 * der Wareneingang, nur ausgelöst von der Produktion statt von der Bestellung.
 */

const fail = (status: number, code: string, message: string) =>
    Object.assign(new Error(message), { status, code });

/* ── FRAGE 1 + 2 + 6: DIE TYPENFAMILIEN ─────────────────────────────────────
 *
 * Der Vorschlag, der Baris zur Bestätigung vorliegt. Er ist VOREINSTELLUNG,
 * nicht Gesetz: die Liste wird beim ersten Öffnen angelegt und danach in den
 * Einstellungen gepflegt — Kürzel, Einheit der Leistungszahl (FRAGE 2) und
 * Kurzschlusspflicht (FRAGE 6) je Familie.
 */
export const DEFAULT_TYPE_FAMILIES: Array<{
    code: string;
    name: string;
    nameDe: string;
    ratingUnit: string;
    requiresShortCircuit: boolean;
}> = [
    { code: 'CP', name: 'Kumanda panosu', nameDe: 'Steuerschrank', ratingUnit: 'KW', requiresShortCircuit: false },
    { code: 'MC', name: 'Motor kontrol merkezi', nameDe: 'Motor Control Center', ratingUnit: 'KW', requiresShortCircuit: true },
    { code: 'FC', name: 'Sürücü panosu', nameDe: 'Frequenzumrichterschrank', ratingUnit: 'KW', requiresShortCircuit: false },
    { code: 'PC', name: 'Pompa kumanda panosu', nameDe: 'Pumpensteuerung', ratingUnit: 'KW', requiresShortCircuit: false },
    { code: 'DB', name: 'Dağıtım panosu', nameDe: 'Verteiler', ratingUnit: 'A', requiresShortCircuit: true },
    { code: 'MS', name: 'Ölçü / sayaç panosu', nameDe: 'Mess- und Zählerschrank', ratingUnit: 'A', requiresShortCircuit: false },
    { code: 'BS', name: 'Şantiye panosu', nameDe: 'Baustromverteiler', ratingUnit: 'A', requiresShortCircuit: true },
    { code: 'TS', name: 'Otomatik transfer panosu', nameDe: 'Umschaltautomatik (ATS)', ratingUnit: 'A', requiresShortCircuit: true },
    { code: 'KK', name: 'Kompanzasyon panosu', nameDe: 'Kompensationsanlage', ratingUnit: 'KVAR', requiresShortCircuit: false },
    { code: 'EX', name: 'Özel pano', nameDe: 'Sonderschrank', ratingUnit: 'NONE', requiresShortCircuit: false },
];

/* ── EINSTELLUNGEN ──────────────────────────────────────────────────────────*/

export interface PanelSettingsRow {
    id: string;
    tenantId: string;
    manufacturerName: string;
    modelPrefix: string;
    serialScope: string;
    serialYearlyReset: boolean;
    serialDigits: number;
    retroBlockStart: number | null;
    variantRules: PanelVariantRules | null;
    defaultStandard: string;
    defaultIpRating: string | null;
    defaultVoltage: number | null;
    defaultPhases: number | null;
    defaultHz: number | null;
    warrantyMonths: number;
    labelWidthMm: number;
    labelHeightMm: number;
    labelMaterial: string | null;
    labelPrinter: string | null;
    labelQrBaseUrl: string | null;
}

/** Die Zeile der Firma; fehlt sie, wird sie mit den Voreinstellungen angelegt. */
export const ensurePanelSettings = async (tenantId: string): Promise<PanelSettingsRow> => {
    const existing = await (prisma as any).panelSettings.findUnique({ where: { tenantId } });
    if (existing) return existing as PanelSettingsRow;
    try {
        const created = await (prisma as any).panelSettings.create({
            data: {
                id: nanoid(12),
                tenantId,
                // FRAGE 5 — Voreinstellung: eine Variante ist nötig, sobald IP
                // oder Spannung von der Hausnorm abweichen.
                variantRules: { ip: true, voltage: true, custom: false },
            },
        });
        return created as PanelSettingsRow;
    } catch (error: any) {
        // Zwei Aufrufe gleichzeitig — der andere war schneller.
        if (error?.code !== 'P2002') throw error;
        return (await (prisma as any).panelSettings.findUnique({ where: { tenantId } })) as PanelSettingsRow;
    }
};

const SETTINGS_NUMBERS = ['serialDigits', 'retroBlockStart', 'defaultVoltage', 'defaultPhases', 'defaultHz', 'warrantyMonths', 'labelWidthMm', 'labelHeightMm'] as const;
const SETTINGS_TEXTS = ['manufacturerName', 'modelPrefix', 'defaultStandard', 'defaultIpRating', 'labelMaterial', 'labelPrinter', 'labelQrBaseUrl'] as const;

export const savePanelSettings = async (tenantId: string, patch: any, userId?: string | null): Promise<PanelSettingsRow> => {
    await ensurePanelSettings(tenantId);
    const data: any = { updatedById: userId || null };

    for (const key of SETTINGS_TEXTS) {
        if (patch[key] !== undefined) {
            const value = patch[key] === null ? null : String(patch[key]).trim();
            data[key] = value || (key === 'manufacturerName' || key === 'modelPrefix' || key === 'defaultStandard' ? undefined : null);
        }
    }
    if (data.modelPrefix) data.modelPrefix = normalizePanelCode(data.modelPrefix, 8) || 'OT';

    for (const key of SETTINGS_NUMBERS) {
        if (patch[key] !== undefined) {
            const value = patch[key] === null || patch[key] === '' ? null : Number(patch[key]);
            if (value !== null && !Number.isFinite(value)) throw fail(400, 'BAD_NUMBER', `«${key}» muss eine Zahl sein.`);
            data[key] = value;
        }
    }
    // FRAGE 3 / 4 — Bereich und Jahreswechsel.
    if (patch.serialScope !== undefined) {
        const scope = String(patch.serialScope || '').toUpperCase();
        if (scope !== 'GROUP' && scope !== 'COMPANY') throw fail(400, 'BAD_SCOPE', 'Seriennummernbereich: GROUP oder COMPANY.');
        data.serialScope = scope;
    }
    if (patch.serialYearlyReset !== undefined) data.serialYearlyReset = Boolean(patch.serialYearlyReset);
    if (patch.variantRules !== undefined) {
        const rules = patch.variantRules || {};
        data.variantRules = { ip: Boolean(rules.ip), voltage: Boolean(rules.voltage), custom: Boolean(rules.custom) };
    }
    if (data.serialDigits !== undefined && data.serialDigits !== null) {
        data.serialDigits = Math.min(9, Math.max(3, Math.trunc(data.serialDigits)));
    }

    return (await (prisma as any).panelSettings.update({ where: { tenantId }, data })) as PanelSettingsRow;
};

/**
 * FRAGE 3 — in wessen Reihe diese Firma zählt. GROUP: die Wurzel des
 * Firmenbaums (eine einzige OffiTec-Serie); COMPANY: die Firma selbst.
 */
export const serialScopeTenantId = async (tenantId: string, settings: PanelSettingsRow): Promise<string> => {
    if (String(settings.serialScope || 'GROUP').toUpperCase() !== 'GROUP') return tenantId;
    return (await findTenantRootIdCached(tenantId)) || tenantId;
};

/* ── TYPENFAMILIEN ──────────────────────────────────────────────────────────*/

/** Beim ersten Öffnen legt sich der Vorschlagskatalog selbst an. */
export const ensureTypeFamilies = async (tenantId: string): Promise<void> => {
    const count = await (prisma as any).panelTypeFamily.count({ where: { tenantId } });
    if (count > 0) return;
    await (prisma as any).panelTypeFamily.createMany({
        data: DEFAULT_TYPE_FAMILIES.map((family, index) => ({
            id: nanoid(12),
            tenantId,
            code: family.code,
            name: family.name,
            nameDe: family.nameDe,
            ratingUnit: family.ratingUnit,
            requiresShortCircuit: family.requiresShortCircuit,
            sortOrder: (index + 1) * 10,
        })),
        skipDuplicates: true,
    });
};

export const listTypeFamilies = async (tenantId: string, options: { activeOnly?: boolean } = {}) => {
    await ensureTypeFamilies(tenantId);
    return (prisma as any).panelTypeFamily.findMany({
        where: { tenantId, ...(options.activeOnly ? { isActive: true } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
};

export const saveTypeFamily = async (tenantId: string, id: string | null, input: any) => {
    const code = normalizePanelCode(input.code, 4);
    if (!isValidFamilyCode(code)) throw fail(400, 'BAD_FAMILY_CODE', 'Kürzel: 2–4 Grossbuchstaben oder Ziffern.');
    const name = String(input.name || '').trim();
    if (!name) throw fail(400, 'NAME_REQUIRED', 'Die Familie braucht einen Namen.');

    const data = {
        tenantId,
        code,
        name,
        nameDe: input.nameDe ? String(input.nameDe).trim() : null,
        ratingUnit: String(input.ratingUnit || 'KW').toUpperCase(),
        requiresShortCircuit: Boolean(input.requiresShortCircuit),
        codeSchemeId: input.codeSchemeId ? String(input.codeSchemeId) : null,
        standard: input.standard ? String(input.standard).trim() : null,
        sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
        isActive: input.isActive === undefined ? true : Boolean(input.isActive),
    };

    try {
        if (id) {
            const existing = await (prisma as any).panelTypeFamily.findFirst({ where: { id, tenantId } });
            if (!existing) throw fail(404, 'FAMILY_NOT_FOUND', 'Typenfamilie nicht gefunden.');
            // Das Kürzel steckt in jeder schon gebildeten Modellnummer — es zu
            // ändern hiesse, vergebene Nummern umzuschreiben.
            if (existing.code !== code) {
                const used = await (prisma as any).panelModel.count({ where: { tenantId, typeFamilyId: id } });
                if (used > 0) throw fail(409, 'FAMILY_CODE_LOCKED', `«${existing.code}» steht schon auf ${used} Modellnummer(n) und kann nicht mehr geändert werden.`);
            }
            return await (prisma as any).panelTypeFamily.update({ where: { id }, data });
        }
        return await (prisma as any).panelTypeFamily.create({ data: { id: nanoid(12), ...data } });
    } catch (error: any) {
        if (error?.code === 'P2002') throw fail(409, 'FAMILY_CODE_TAKEN', `Das Kürzel «${code}» gibt es schon.`);
        throw error;
    }
};

export const deleteTypeFamily = async (tenantId: string, id: string) => {
    const used = await (prisma as any).panelModel.count({ where: { tenantId, typeFamilyId: id } });
    if (used > 0) throw fail(409, 'FAMILY_IN_USE', `Zu dieser Familie gehören ${used} Modell(e); sie kann nur stillgelegt werden.`);
    await (prisma as any).panelTypeFamily.deleteMany({ where: { id, tenantId } });
};

/* ── MODELLE ────────────────────────────────────────────────────────────────*/

export interface PanelModelInput {
    typeFamilyId: string;
    ratingValue: number;
    variantCode?: string | null;
    name?: string | null;
    /** Nummernkreis für die Produktnummer, falls die Familie keinen trägt. */
    codeSchemeId?: string | null;
    ratedVoltage?: number | null;
    ratedCurrent?: number | null;
    phaseCount?: number | null;
    frequency?: number | null;
    shortCircuitIcw?: number | null;
    shortCircuitTime?: number | null;
    shortCircuitIpk?: number | null;
    ipRating?: string | null;
    standard?: string | null;
    ceMarking?: boolean;
    notes?: string | null;
    hasCustomDeviation?: boolean;
    salePrice?: number | null;
    unit?: string | null;
}

/** Die Bezeichnung der Produktkarte, wenn keine getippt wurde. */
const defaultModelName = (family: any, input: PanelModelInput): string => {
    const unit = ratingUnitLabel(family.ratingUnit);
    const rating = unit ? ` ${Math.trunc(input.ratingValue)} ${unit}` : '';
    return `${family.name}${rating}`.trim();
};

/**
 * Ein neues MODELL: Produktkarte (mit ERP-Code aus dem Nummernkreis) plus
 * Typenschildwerte. Die Modellnummer wird gebildet und ist eindeutig — gleiche
 * Technik zweimal anzulegen, lehnt der Schlüssel ab.
 */
export const createPanelModel = async (tenantId: string, input: PanelModelInput, userId?: string | null) => {
    const settings = await ensurePanelSettings(tenantId);
    await ensureTypeFamilies(tenantId);

    const family = await (prisma as any).panelTypeFamily.findFirst({ where: { id: String(input.typeFamilyId || ''), tenantId } });
    if (!family) throw fail(404, 'FAMILY_NOT_FOUND', 'Typenfamilie nicht gefunden.');
    if (!family.isActive) throw fail(409, 'FAMILY_INACTIVE', 'Diese Typenfamilie ist stillgelegt.');

    // Ein Panomodell ist eine technische Stammkarte, kein Entwurf. Alle Werte,
    // die später das Typenschild tragen, müssen beim Anlegen vollständig sein.
    const effectiveRequired = {
        name: String(input.name || '').trim(),
        ratedVoltage: Number(input.ratedVoltage ?? settings.defaultVoltage),
        ratedCurrent: Number(input.ratedCurrent),
        phaseCount: Number(input.phaseCount ?? settings.defaultPhases),
        frequency: Number(input.frequency ?? settings.defaultHz),
        ipRating: String(input.ipRating || settings.defaultIpRating || '').trim(),
        standard: String(input.standard || family.standard || settings.defaultStandard || '').trim(),
        shortCircuitIcw: Number(input.shortCircuitIcw),
        shortCircuitTime: Number(input.shortCircuitTime),
        shortCircuitIpk: Number(input.shortCircuitIpk),
    };
    const missingRequired = [
        !effectiveRequired.name && 'name',
        !(effectiveRequired.ratedVoltage > 0) && 'ratedVoltage',
        !(effectiveRequired.ratedCurrent > 0) && 'ratedCurrent',
        !(effectiveRequired.phaseCount > 0) && 'phaseCount',
        !(effectiveRequired.frequency > 0) && 'frequency',
        !effectiveRequired.ipRating && 'ipRating',
        !effectiveRequired.standard && 'standard',
        !(effectiveRequired.shortCircuitIcw > 0) && 'shortCircuitIcw',
        !(effectiveRequired.shortCircuitTime > 0) && 'shortCircuitTime',
        !(effectiveRequired.shortCircuitIpk > 0) && 'shortCircuitIpk',
    ].filter(Boolean);
    if (missingRequired.length) {
        throw Object.assign(new Error('Pano modelinin zorunlu teknik alanları eksik.'), {
            status: 400,
            code: 'MODEL_FIELDS_REQUIRED',
            details: { fields: missingRequired },
        });
    }

    const ratingValue = Math.trunc(Number(input.ratingValue) || 0);
    if (family.ratingUnit !== 'NONE' && ratingValue <= 0) {
        throw fail(400, 'RATING_REQUIRED', `Die Leistungsklasse (${ratingUnitLabel(family.ratingUnit)}) fehlt.`);
    }

    const variantCode = input.variantCode ? normalizePanelCode(input.variantCode, 8) : '';
    if (variantCode && !isValidVariantCode(variantCode)) {
        throw fail(400, 'BAD_VARIANT', 'Variantenkürzel: 1–8 Grossbuchstaben oder Ziffern.');
    }

    // FRAGE 5 — braucht dieses Modell überhaupt ein Kürzel?
    const reasons = variantRequiredReasons(
        settings.variantRules,
        { ipRating: settings.defaultIpRating, ratedVoltage: settings.defaultVoltage },
        {
            ipRating: input.ipRating,
            ratedVoltage: input.ratedVoltage ?? null,
            hasCustomDeviation: input.hasCustomDeviation,
            variantCode,
        },
    );
    if (reasons.length && !variantCode) {
        throw Object.assign(
            new Error('Dieses Modell weicht von der Hausnorm ab und braucht ein Variantenkürzel.'),
            { status: 409, code: 'VARIANT_REQUIRED', details: { reasons } },
        );
    }

    const modelNumber = formatPanelModelNumber({
        prefix: settings.modelPrefix,
        typeCode: family.code,
        ratingValue,
        variantCode,
    });

    const taken = await (prisma as any).panelModel.findFirst({
        where: { tenantId, modelNumber },
        select: { id: true, articleId: true },
    });
    if (taken) {
        throw Object.assign(
            new Error(`Die Modellnummer «${modelNumber}» gibt es schon — gleiche Technik ist dasselbe Modell.`),
            { status: 409, code: 'MODEL_NUMBER_TAKEN', details: { panelModelId: taken.id, articleId: taken.articleId } },
        );
    }

    // Die PRODUKTNUMMER kommt aus dem Nummernkreis der Familie (oder dem
    // mitgegebenen) — derselbe Zähler, der auch das Lager nummeriert.
    const schemeId = String(input.codeSchemeId || family.codeSchemeId || '');
    if (!schemeId) {
        throw fail(409, 'CODE_SCHEME_MISSING', 'Für diese Typenfamilie ist kein Nummernkreis hinterlegt (Einstellungen → Code-Einstellungen).');
    }
    const { codes } = await issueCodes(tenantId, schemeId, 1);
    const articleCode = codes[0];

    const articleId = nanoid(10);
    const panelModelId = nanoid(12);
    const name = String(input.name || '').trim() || defaultModelName(family, input);

    const created = await (prisma as any).$transaction(async (tx: any) => {
        await tx.article.create({
            data: {
                id: articleId,
                tenantId,
                articleCode,
                // Die Modellnummer steht AUCH auf der Produktkarte — dort sucht
                // sie jeder (Liste, Schnellerfassung, Wareneingang).
                modelNumber,
                name,
                unit: String(input.unit || 'Stk'),
                itemType: 'PRODUCT',
                status: 'ACTIVE',
                isActive: true,
                salePrice: Number(input.salePrice) > 0 ? Number(input.salePrice) : 0,
                baseCost: 0,
            },
        });
        return tx.panelModel.create({
            data: {
                id: panelModelId,
                tenantId,
                articleId,
                typeFamilyId: family.id,
                typeCode: family.code,
                ratingValue,
                ratingUnit: family.ratingUnit,
                variantCode: variantCode || null,
                modelNumber,
                manufacturer: settings.manufacturerName,
                ratedVoltage: input.ratedVoltage ?? settings.defaultVoltage ?? null,
                ratedCurrent: input.ratedCurrent ?? null,
                phaseCount: input.phaseCount ?? settings.defaultPhases ?? null,
                frequency: input.frequency ?? settings.defaultHz ?? null,
                shortCircuitIcw: input.shortCircuitIcw ?? null,
                shortCircuitTime: input.shortCircuitTime ?? null,
                shortCircuitIpk: input.shortCircuitIpk ?? null,
                ipRating: input.ipRating ? String(input.ipRating).trim().toUpperCase() : settings.defaultIpRating,
                standard: String(input.standard || family.standard || settings.defaultStandard).trim(),
                ceMarking: input.ceMarking === undefined ? true : Boolean(input.ceMarking),
                notes: input.notes ? String(input.notes) : null,
                createdById: userId || null,
            },
        });
    });

    /* Der gewählte Kreis wird AM TYP gemerkt: beim nächsten Modell derselben
       Familie steht er schon da (Vorgabe Samet, 20.09.2026 — gewählt wird
       einmal, nicht jedes Mal). Schlägt das fehl, ist das Modell trotzdem
       angelegt; die Wahl kostet dann nur einen Klick mehr. */
    if (schemeId && family.codeSchemeId !== schemeId) {
        await (prisma as any).panelTypeFamily
            .update({ where: { id: family.id }, data: { codeSchemeId: schemeId } })
            .catch(() => undefined);
    }

    return { ...created, articleCode };
};

/** Technische Werte ändern; Nummer und Produktkarte bleiben. */
export const updatePanelModel = async (tenantId: string, id: string, patch: any) => {
    const model = await (prisma as any).panelModel.findFirst({ where: { id, tenantId } });
    if (!model) throw fail(404, 'MODEL_NOT_FOUND', 'Modell nicht gefunden.');
    const nextName = patch.name !== undefined ? String(patch.name || '').trim() : null;
    if (patch.name !== undefined && !nextName) {
        throw fail(400, 'MODEL_FIELDS_REQUIRED', 'Pano modeli açıklaması zorunludur.');
    }

    const nextValue = (key: string) => patch[key] !== undefined ? patch[key] : model[key];
    const requiredAfterUpdate = {
        ratedVoltage: Number(nextValue('ratedVoltage')),
        ratedCurrent: Number(nextValue('ratedCurrent')),
        phaseCount: Number(nextValue('phaseCount')),
        frequency: Number(nextValue('frequency')),
        shortCircuitIcw: Number(nextValue('shortCircuitIcw')),
        shortCircuitTime: Number(nextValue('shortCircuitTime')),
        shortCircuitIpk: Number(nextValue('shortCircuitIpk')),
        ipRating: String(nextValue('ipRating') ?? '').trim(),
        standard: String(nextValue('standard') ?? '').trim(),
    };
    const missing = Object.entries(requiredAfterUpdate)
        .filter(([key, value]) => (key === 'ipRating' || key === 'standard') ? !value : !(Number(value) > 0))
        .map(([key]) => key);
    if (missing.length) {
        throw Object.assign(new Error('Pano modelinin zorunlu teknik alanları eksik.'), {
            status: 400,
            code: 'MODEL_FIELDS_REQUIRED',
            details: { fields: missing },
        });
    }

    const data: any = {};
    for (const key of ['ratedVoltage', 'ratedCurrent', 'phaseCount', 'frequency', 'shortCircuitIcw', 'shortCircuitTime', 'shortCircuitIpk'] as const) {
        if (patch[key] !== undefined) {
            const value = patch[key] === null || patch[key] === '' ? null : Number(patch[key]);
            if (value !== null && !Number.isFinite(value)) throw fail(400, 'BAD_NUMBER', `«${key}» muss eine Zahl sein.`);
            data[key] = value;
        }
    }
    if (patch.ipRating !== undefined) data.ipRating = patch.ipRating ? String(patch.ipRating).trim().toUpperCase() : null;
    if (patch.standard !== undefined) data.standard = patch.standard ? String(patch.standard).trim() : null;
    if (patch.ceMarking !== undefined) data.ceMarking = Boolean(patch.ceMarking);
    if (patch.notes !== undefined) data.notes = patch.notes ? String(patch.notes) : null;
    if (patch.isActive !== undefined) data.isActive = Boolean(patch.isActive);

    const updated = await (prisma as any).panelModel.update({ where: { id }, data });
    if (patch.name !== undefined) {
        await (prisma as any).article.update({ where: { id: model.articleId }, data: { name: nextName } });
    }
    return updated;
};

/**
 * DIE EINLAGERUNG EINES GELÖSCHTEN SCHRANKS ZURÜCKNEHMEN — seine `IN`-Bewegung
 * fällt weg und der Bestand geht um dieselbe Menge zurück (dieselbe Regel wie
 * beim gelöschten Wareneingang). Ohne das stünde im Lager ein Stück, dessen
 * Schrank es nicht mehr gibt.
 */
const revertPanelStockMovements = async (tx: any, tenantId: string, movementIds: string[]) => {
    const ids = movementIds.filter(Boolean).map(String);
    if (!ids.length) return;
    const movements = await tx.stockMovement.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, articleId: true, quantity: true, destinationLocationId: true },
    });
    if (!movements.length) return;
    await tx.stockMovement.deleteMany({ where: { tenantId, id: { in: movements.map((row: any) => String(row.id)) } } });
    for (const movement of movements) {
        // Konumsuz hareket bakiye yazmamıştır — geri alacak bir şey de yoktur.
        if (!movement.destinationLocationId) continue;
        await tx.$executeRawUnsafe(
            'UPDATE `StockBalance` SET `currentQuantity` = `currentQuantity` - ?, `updatedAt` = NOW(3) '
            + 'WHERE `tenantId` = ? AND `articleId` = ? AND `locationId` = ?',
            Number(movement.quantity) || 0, tenantId, movement.articleId, movement.destinationLocationId,
        );
    }
};

/**
 * Ein Modell wird DIREKT gelöscht — auch wenn schon Schränke davon gezählt
 * sind (Vorgabe Samet, 21.09.2026: kein «Modell stilllegen»-Umweg mehr).
 * Die Seriensätze hängen am Fremdschlüssel und müssen deshalb im selben
 * Zug mitgehen; die gezogenen Nummern bleiben im Zähler verbraucht und
 * werden nie erneut vergeben. Die Produktkarte wird NICHT hart gelöscht:
 * Lager- und Angebotsverweise bleiben dadurch revisionssicher.
 */
export const deletePanelModel = async (tenantId: string, id: string) => {
    const model = await (prisma as any).panelModel.findFirst({ where: { id, tenantId } });
    if (!model) throw fail(404, 'MODEL_NOT_FOUND', 'Pano modeli bulunamadı.');
    // Eingelagerte Schränke dieses Modells: ihre Buchungen gehen mit.
    const stocked = await (prisma as any).panelUnit.findMany({
        where: { tenantId, panelModelId: model.id, stockMovementId: { not: null } },
        select: { stockMovementId: true },
    });
    await (prisma as any).$transaction(async (tx: any) => {
        await revertPanelStockMovements(tx, tenantId, stocked.map((row: any) => String(row.stockMovementId)));
        await tx.panelUnit.deleteMany({ where: { panelModelId: model.id } });
        await tx.panelModel.delete({ where: { id: model.id } });
        await tx.article.update({
            where: { id: model.articleId },
            data: { deletedAt: new Date(), status: 'INACTIVE', isActive: false },
        });
    });
};

/* ── TYPENSCHILD ────────────────────────────────────────────────────────────*/

export interface NameplateFieldsMissing {
    field: string;
    label: string;
}

/**
 * Was dem Schild noch fehlt. Ein Schild darf NICHT gedruckt werden, solange
 * hier etwas steht — ein unvollständiges Typenschild ist schlimmer als keines.
 * Die Kurzschlussangabe verlangt die FAMILIE (FRAGE 6), nicht der Code.
 */
export const missingNameplateFields = (model: any, _family: any): NameplateFieldsMissing[] => {
    const missing: NameplateFieldsMissing[] = [];
    if (!model.manufacturer) missing.push({ field: 'manufacturer', label: 'Üretici' });
    if (!model.modelNumber) missing.push({ field: 'modelNumber', label: 'Model numarası' });
    if (!(Number(model.ratedVoltage) > 0)) missing.push({ field: 'ratedVoltage', label: 'Anma gerilimi (Ue)' });
    if (!(Number(model.ratedCurrent) > 0)) missing.push({ field: 'ratedCurrent', label: 'Anma akımı (InA)' });
    if (!(Number(model.phaseCount) > 0)) missing.push({ field: 'phaseCount', label: 'Faz sayısı' });
    if (!(Number(model.frequency) > 0)) missing.push({ field: 'frequency', label: 'Frekans' });
    if (!model.ipRating) missing.push({ field: 'ipRating', label: 'IP koruma sınıfı' });
    if (!model.standard) missing.push({ field: 'standard', label: 'Uygulanan standart' });
    if (!(Number(model.shortCircuitIcw) > 0)) missing.push({ field: 'shortCircuitIcw', label: 'Kısa devre dayanımı (Icw)' });
    if (!(Number(model.shortCircuitTime) > 0)) missing.push({ field: 'shortCircuitTime', label: 'Icw süresi' });
    if (!(Number(model.shortCircuitIpk) > 0)) missing.push({ field: 'shortCircuitIpk', label: 'Tepe kısa devre akımı (Ipk)' });
    return missing;
};

/** Die eingefrorene Schildkopie eines Schranks. */
export const buildNameplate = (model: any, unit: any, settings: PanelSettingsRow) => ({
    manufacturer: model.manufacturer || settings.manufacturerName,
    modelNumber: model.modelNumber,
    serialNumber: unit.serialNumber,
    productionYear: unit.productionYear ?? unit.serialYear,
    ratedVoltage: model.ratedVoltage ?? null,
    ratedCurrent: model.ratedCurrent ?? null,
    phaseCount: model.phaseCount ?? null,
    frequency: model.frequency ?? null,
    shortCircuitIcw: model.shortCircuitIcw ?? null,
    shortCircuitTime: model.shortCircuitTime ?? null,
    shortCircuitIpk: model.shortCircuitIpk ?? null,
    ipRating: model.ipRating ?? null,
    standard: model.standard ?? settings.defaultStandard,
    ceMarking: model.ceMarking !== false,
    orderNumber: unit.orderNumber ?? null,
    frozenAt: new Date().toISOString(),
});

/* ── SCHRÄNKE (SERIENNUMMERN) ───────────────────────────────────────────────*/

export interface IssueUnitsInput {
    panelModelId: string;
    count: number;
    /** FRAGE 7 — Nachtrag für einen Altschrank aus dem eigenen Block. */
    retro?: boolean;
    year?: number;
    productionProjectId?: string | null;
    productionItemId?: string | null;
    projectId?: string | null;
    salesOrderId?: string | null;
    orderNumber?: string | null;
    customerId?: string | null;
    customerName?: string | null;
    siteName?: string | null;
    notes?: string | null;
}

/** Projekt und Gerät sind freiwillig; ein gewähltes Gerät muss aber zum
 * gewählten Projekt und zur aktuellen Firma gehören. */
const validatePanelProductionLink = async (
    tenantId: string,
    productionProjectId?: string | null,
    productionItemId?: string | null,
) => {
    const projectId = productionProjectId ? String(productionProjectId) : null;
    const itemId = productionItemId ? String(productionItemId) : null;
    if (!projectId && itemId) throw fail(400, 'PANEL_PROJECT_REQUIRED', 'Cihaz bağlantısı için önce proje seçilmelidir.');
    if (!projectId) return;
    const project = await (prisma as any).productionProject.findFirst({ where: { id: projectId, tenantId, isActive: true }, select: { id: true } });
    if (!project) throw fail(404, 'PROJECT_NOT_FOUND', 'Üretim projesi bulunamadı.');
    if (!itemId) return;
    const item = await (prisma as any).productionProjectItem.findFirst({
        where: { id: itemId, tenantId, productionProjectId: projectId, isActive: true, kind: 'DEVICE' },
        select: { id: true },
    });
    if (!item) throw fail(400, 'PANEL_DEVICE_INVALID', 'Seçilen cihaz bu projeye ait değil.');
};

/**
 * `count` Seriennummern für ein Modell — der Augenblick, in dem aus einem Typ
 * einzelne Schränke werden. Absichtlich VOR dem Schaltplan: die Nummer soll im
 * Plan stehen (Vorgabe Baris).
 */
export const issuePanelUnits = async (tenantId: string, input: IssueUnitsInput, userId?: string | null) => {
    const settings = await ensurePanelSettings(tenantId);
    const model = await (prisma as any).panelModel.findFirst({
        where: { id: String(input.panelModelId || ''), tenantId },
        include: { typeFamily: true },
    });
    if (!model) throw fail(404, 'MODEL_NOT_FOUND', 'Modell nicht gefunden.');
    if (!model.isActive) throw fail(409, 'MODEL_INACTIVE', 'Dieses Modell ist stillgelegt.');
    await validatePanelProductionLink(tenantId, input.productionProjectId, input.productionItemId);

    const count = Math.max(1, Math.min(200, Math.trunc(Number(input.count) || 1)));
    const year = Math.trunc(Number(input.year) || new Date().getFullYear());
    const scopeTenantId = await serialScopeTenantId(tenantId, settings);

    const serialOptions: PanelSerialOptions = {
        year,
        digits: settings.serialDigits,
        yearlyReset: settings.serialYearlyReset,
        retro: Boolean(input.retro),
        retroBlockStart: settings.retroBlockStart,
    };

    // Ziehen und Anlegen in EINER Transaktion: bricht etwas ab, ist auch keine
    // Nummer vergeben.
    return (prisma as any).$transaction(async (tx: any) => {
        const serials = await nextPanelSerials(scopeTenantId, count, serialOptions, tx);
        const rows = serials.map((serial) => ({
            id: nanoid(12),
            tenantId,
            serialTenantId: scopeTenantId,
            serialNumber: serial.serialNumber,
            serialYear: serial.year,
            serialSeq: serial.seq,
            isRetro: serial.isRetro,
            panelModelId: model.id,
            articleId: model.articleId,
            modelNumberSnapshot: model.modelNumber,
            status: 'PLANNED',
            productionProjectId: input.productionProjectId || null,
            productionItemId: input.productionItemId || null,
            projectId: input.projectId || null,
            salesOrderId: input.salesOrderId || null,
            orderNumber: input.orderNumber || null,
            customerId: input.customerId || null,
            customerName: input.customerName || null,
            siteName: input.siteName || null,
            productionYear: serial.year,
            notes: input.notes || null,
            createdById: userId || null,
        }));
        await tx.panelUnit.createMany({ data: rows });
        return rows;
    });
};

/** Der Lebenslauf eines Schranks — jede Stufe darf nur vorwärts oder zurück zu «abgebrochen». */
export const PANEL_UNIT_STATUS = ['PLANNED', 'IN_PRODUCTION', 'TESTED', 'STOCKED', 'RESERVED', 'SHIPPED', 'INSTALLED', 'CANCELLED'] as const;
export type PanelUnitStatus = typeof PANEL_UNIT_STATUS[number];

/* ── DER SCHRANK GEHT INS LAGER ─────────────────────────────────────────────
 *
 * Das Gegenstück zum Wareneingang: dort löst eine Lieferantenbestellung die
 * Buchung aus, hier die fertige Produktion. Gebucht wird über die PRODUKTKARTE
 * DES MODELLS (Menge 1) — es entsteht KEINE eigene Produktkarte je Schrank;
 * welcher Schrank es war, sagt `StockMovement.serialNumber`.
 */
export const stockInPanelUnit = async (
    tenantId: string,
    unitId: string,
    employeeId: string,
    options: { unitCost?: number | null; description?: string | null } = {},
) => {
    const unit = await (prisma as any).panelUnit.findFirst({ where: { id: unitId, tenantId }, include: { model: true } });
    if (!unit) throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    if (unit.status === 'CANCELLED') throw fail(409, 'UNIT_CANCELLED', 'Dieser Schrank ist storniert.');
    if (unit.stockMovementId) throw fail(409, 'ALREADY_STOCKED', 'Dieser Schrank ist schon im Lager gebucht.');
    const articleId = unit.articleId || unit.model?.articleId;
    if (!articleId) throw fail(409, 'ARTICLE_MISSING', 'Dem Modell fehlt seine Produktkarte.');

    const location = await new InventoryRepository().ensureDefaultLocation(tenantId);
    const movementId = nanoid(12);
    const now = new Date();

    await (prisma as any).$transaction(async (tx: any) => {
        await tx.stockMovement.create({
            data: {
                id: movementId,
                tenantId,
                articleId,
                movementType: 'IN',
                quantity: 1,
                unitCost: Number(options.unitCost) > 0 ? Number(options.unitCost) : null,
                destinationLocationId: location.id,
                employeeId,
                // Herkunft: eigene Fertigung — nicht Wareneingang, nicht Schnellerfassung.
                origin: 'PRODUCTION',
                // Die Bewegung TRÄGT die Seriennummer; daran hängt die Rückverfolgung.
                serialNumber: unit.serialNumber,
                referenceId: unit.productionProjectId || unit.projectId || unit.salesOrderId || null,
                description: options.description ? String(options.description).slice(0, 500) : null,
                transactionDate: now,
            },
        });
        await tx.$executeRawUnsafe(
            'INSERT INTO `StockBalance` (`id`, `tenantId`, `articleId`, `locationId`, `currentQuantity`, `reservedQuantity`, `updatedAt`) '
            + 'VALUES (?, ?, ?, ?, 1, 0, NOW(3)) '
            + 'ON DUPLICATE KEY UPDATE `currentQuantity` = `currentQuantity` + 1, `updatedAt` = NOW(3)',
            nanoid(10), tenantId, articleId, location.id,
        );
        await tx.panelUnit.update({
            where: { id: unit.id },
            data: {
                stockMovementId: movementId,
                status: 'STOCKED',
                manufacturedAt: unit.manufacturedAt ?? now,
                productionYear: unit.productionYear ?? now.getFullYear(),
            },
        });
    });

    return (prisma as any).panelUnit.findFirst({ where: { id: unit.id }, include: { model: true } });
};

/**
 * ETIKETT DRUCKEN — friert die Schildwerte auf dem Schrank ein. Danach ist der
 * Satz das, was wirklich am Schrank klebt; spätere Modelländerungen berühren
 * ihn nicht mehr (dieselbe Regel wie die Spaltenkopie der Bestell-PDFs).
 *
 * Fehlt ein Pflichtwert, wird NICHT gedruckt: ein halbes Typenschild ist
 * schlimmer als keines (`NAMEPLATE_INCOMPLETE` nennt die fehlenden Felder).
 */
export const freezeNameplate = async (tenantId: string, unitId: string, userId?: string | null) => {
    const settings = await ensurePanelSettings(tenantId);
    const unit = await (prisma as any).panelUnit.findFirst({
        where: { id: unitId, tenantId },
        include: { model: { include: { typeFamily: true } } },
    });
    if (!unit) throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    if (unit.status === 'CANCELLED') throw fail(409, 'UNIT_CANCELLED', 'Dieser Schrank ist storniert.');

    const missing = missingNameplateFields(unit.model, unit.model?.typeFamily);
    if (missing.length) {
        throw Object.assign(
            new Error('Dem Typenschild fehlen Pflichtangaben.'),
            { status: 409, code: 'NAMEPLATE_INCOMPLETE', details: { missing } },
        );
    }

    const nameplate = buildNameplate(unit.model, unit, settings);
    const updated = await (prisma as any).panelUnit.update({
        where: { id: unit.id },
        data: {
            nameplate,
            labelPrintedAt: new Date(),
            labelPrintedById: userId || null,
            modelNumberSnapshot: unit.model.modelNumber,
        },
    });
    return {
        unit: updated,
        nameplate,
        label: { widthMm: settings.labelWidthMm, heightMm: settings.labelHeightMm, qrBaseUrl: settings.labelQrBaseUrl },
    };
};

/**
 * Stufenwechsel. Vorwärts ist frei, zurück nicht — nur «abgebrochen» ist von
 * überall erreichbar, und eine abgebrochene Nummer wird NIE neu vergeben
 * (die Zeile bleibt stehen, damit die Serie lückenlos nachvollziehbar ist).
 */
export const setPanelUnitStatus = async (tenantId: string, unitId: string, status: string, userId?: string | null) => {
    const next = String(status || '').toUpperCase() as PanelUnitStatus;
    if (!(PANEL_UNIT_STATUS as readonly string[]).includes(next)) throw fail(400, 'BAD_STATUS', 'Unbekannte Stufe.');

    const unit = await (prisma as any).panelUnit.findFirst({ where: { id: unitId, tenantId } });
    if (!unit) throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    if (unit.status === next) return unit;
    if (unit.status === 'CANCELLED') throw fail(409, 'UNIT_CANCELLED', 'Ein stornierter Schrank wird nicht wiederbelebt.');

    const order = PANEL_UNIT_STATUS.indexOf(unit.status as PanelUnitStatus);
    const target = PANEL_UNIT_STATUS.indexOf(next);
    if (next !== 'CANCELLED' && target < order) {
        throw fail(409, 'STATUS_BACKWARDS', 'Eine Stufe geht nicht zurück.');
    }

    const settings = await ensurePanelSettings(tenantId);
    const now = new Date();
    const data: any = { status: next };
    if (next === 'TESTED') {
        data.testedAt = unit.testedAt ?? now;
        data.testedById = unit.testedById ?? (userId || null);
    }
    if (next === 'SHIPPED' || next === 'INSTALLED') {
        data.deliveredAt = unit.deliveredAt ?? now;
        if (!unit.warrantyUntil && settings.warrantyMonths > 0) {
            const until = new Date(data.deliveredAt);
            until.setMonth(until.getMonth() + settings.warrantyMonths);
            data.warrantyUntil = until;
        }
    }
    return (prisma as any).panelUnit.update({ where: { id: unit.id }, data });
};

/** Schrankdaten pflegen: Schaltplan, Kunde, Baustelle, Notiz, Daten. */
export const updatePanelUnit = async (tenantId: string, unitId: string, patch: any) => {
    const unit = await (prisma as any).panelUnit.findFirst({ where: { id: unitId, tenantId } });
    if (!unit) throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');

    const linkedProjectId = patch.productionProjectId !== undefined
        ? (patch.productionProjectId ? String(patch.productionProjectId) : null)
        : unit.productionProjectId;
    const linkedItemId = patch.productionItemId !== undefined
        ? (patch.productionItemId ? String(patch.productionItemId) : null)
        : unit.productionItemId;
    await validatePanelProductionLink(tenantId, linkedProjectId, linkedItemId);

    const data: any = {};
    for (const key of ['schemaNumber', 'schemaRevision', 'schemaFileUrl', 'customerName', 'siteName', 'orderNumber', 'notes'] as const) {
        if (patch[key] !== undefined) data[key] = patch[key] ? String(patch[key]).trim() : null;
    }
    for (const key of ['productionProjectId', 'productionItemId', 'projectId', 'salesOrderId', 'customerId'] as const) {
        if (patch[key] !== undefined) data[key] = patch[key] ? String(patch[key]) : null;
    }
    for (const key of ['manufacturedAt', 'testedAt', 'deliveredAt', 'warrantyUntil'] as const) {
        if (patch[key] !== undefined) data[key] = patch[key] ? new Date(patch[key]) : null;
    }
    if (patch.productionYear !== undefined) {
        const year = Number(patch.productionYear);
        data.productionYear = Number.isFinite(year) && year > 1900 ? Math.trunc(year) : null;
    }
    return (prisma as any).panelUnit.update({ where: { id: unit.id }, data });
};

/**
 * SCHRANK LÖSCHEN — jeder Satz, in jedem Zustand (Vorgabe Samet, 21.09.2026):
 * «direkt silinebilmeli». Früher war ein etikettierter, eingelagerter oder
 * fertiger Schrank gesperrt; diese Sperre gibt es nicht mehr.
 *
 * Gelöscht wird aber nicht nur die Zeile: liegt der Schrank im Lager, wird
 * SEINE EINLAGERUNG ZURÜCKGENOMMEN — die `IN`-Bewegung fällt weg und der
 * Bestand geht um dieselbe Menge zurück (dieselbe Regel wie beim gelöschten
 * Wareneingang). Sonst stünde im Lager ein Stück, das es nicht mehr gibt.
 *
 * Die gezogene Seriennummer bleibt im Zähler verbraucht und wird nie erneut
 * vergeben — eine Nummer, die einmal auf einem Schild stand, kommt nicht wieder.
 */
export const deletePanelUnit = async (tenantId: string, unitId: string) => {
    const unit = await (prisma as any).panelUnit.findFirst({ where: { id: unitId, tenantId } });
    if (!unit) throw fail(404, 'UNIT_NOT_FOUND', 'Pano bulunamadı.');

    await (prisma as any).$transaction(async (tx: any) => {
        // Liegt der Schrank im Lager, wird SEINE Einlagerung zurückgenommen.
        await revertPanelStockMovements(tx, tenantId, unit.stockMovementId ? [String(unit.stockMovementId)] : []);
        await tx.panelUnit.delete({ where: { id: unit.id } });
    });
};

/**
 * DIE SUCHE ÜBER DIE SERIENNUMMER — der Weg, den Baris im Sinn hat: Etikett
 * lesen (oder QR scannen), alles andere findet sich. Gesucht wird im ganzen
 * Seriennummern-Bereich, nicht nur in der eigenen Firma.
 */
export const findPanelBySerial = async (tenantId: string, serialNumber: string) => {
    const settings = await ensurePanelSettings(tenantId);
    const scopeTenantId = await serialScopeTenantId(tenantId, settings);
    const serial = String(serialNumber || '').trim();
    if (!serial) return null;
    return (prisma as any).panelUnit.findFirst({
        where: { serialTenantId: scopeTenantId, serialNumber: serial },
        include: { model: { include: { typeFamily: true } } },
    });
};
