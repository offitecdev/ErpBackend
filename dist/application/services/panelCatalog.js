"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findPanelBySerial = exports.deletePanelUnit = exports.updatePanelUnit = exports.setPanelUnitStatus = exports.freezeNameplate = exports.stockInPanelUnit = exports.PANEL_UNIT_STATUS = exports.issuePanelUnits = exports.buildNameplate = exports.missingNameplateFields = exports.deletePanelModel = exports.updatePanelModel = exports.createPanelModel = exports.deleteTypeFamily = exports.saveTypeFamily = exports.listTypeFamilies = exports.ensureTypeFamilies = exports.serialScopeTenantId = exports.savePanelSettings = exports.ensurePanelSettings = exports.DEFAULT_TYPE_FAMILIES = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const tenantTree_1 = require("../../shared/tenantTree");
const articleCodeCatalog_1 = require("./articleCodeCatalog");
const panelModelNumber_1 = require("../../shared/panelModelNumber");
const panelSerial_1 = require("../../shared/panelSerial");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
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
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
/* ── FRAGE 1 + 2 + 6: DIE TYPENFAMILIEN ─────────────────────────────────────
 *
 * Der Vorschlag, der Baris zur Bestätigung vorliegt. Er ist VOREINSTELLUNG,
 * nicht Gesetz: die Liste wird beim ersten Öffnen angelegt und danach in den
 * Einstellungen gepflegt — Kürzel, Einheit der Leistungszahl (FRAGE 2) und
 * Kurzschlusspflicht (FRAGE 6) je Familie.
 */
exports.DEFAULT_TYPE_FAMILIES = [
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
/** Die Zeile der Firma; fehlt sie, wird sie mit den Voreinstellungen angelegt. */
const ensurePanelSettings = async (tenantId) => {
    const existing = await prisma_client_1.default.panelSettings.findUnique({ where: { tenantId } });
    if (existing)
        return existing;
    try {
        const created = await prisma_client_1.default.panelSettings.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                // FRAGE 5 — Voreinstellung: eine Variante ist nötig, sobald IP
                // oder Spannung von der Hausnorm abweichen.
                variantRules: { ip: true, voltage: true, custom: false },
            },
        });
        return created;
    }
    catch (error) {
        // Zwei Aufrufe gleichzeitig — der andere war schneller.
        if (error?.code !== 'P2002')
            throw error;
        return (await prisma_client_1.default.panelSettings.findUnique({ where: { tenantId } }));
    }
};
exports.ensurePanelSettings = ensurePanelSettings;
const SETTINGS_NUMBERS = ['serialDigits', 'retroBlockStart', 'defaultVoltage', 'defaultPhases', 'defaultHz', 'warrantyMonths', 'labelWidthMm', 'labelHeightMm'];
const SETTINGS_TEXTS = ['manufacturerName', 'modelPrefix', 'defaultStandard', 'defaultIpRating', 'labelMaterial', 'labelPrinter', 'labelQrBaseUrl'];
const savePanelSettings = async (tenantId, patch, userId) => {
    await (0, exports.ensurePanelSettings)(tenantId);
    const data = { updatedById: userId || null };
    for (const key of SETTINGS_TEXTS) {
        if (patch[key] !== undefined) {
            const value = patch[key] === null ? null : String(patch[key]).trim();
            data[key] = value || (key === 'manufacturerName' || key === 'modelPrefix' || key === 'defaultStandard' ? undefined : null);
        }
    }
    if (data.modelPrefix)
        data.modelPrefix = (0, panelModelNumber_1.normalizePanelCode)(data.modelPrefix, 8) || 'OT';
    for (const key of SETTINGS_NUMBERS) {
        if (patch[key] !== undefined) {
            const value = patch[key] === null || patch[key] === '' ? null : Number(patch[key]);
            if (value !== null && !Number.isFinite(value))
                throw fail(400, 'BAD_NUMBER', `«${key}» muss eine Zahl sein.`);
            data[key] = value;
        }
    }
    // FRAGE 3 / 4 — Bereich und Jahreswechsel.
    if (patch.serialScope !== undefined) {
        const scope = String(patch.serialScope || '').toUpperCase();
        if (scope !== 'GROUP' && scope !== 'COMPANY')
            throw fail(400, 'BAD_SCOPE', 'Seriennummernbereich: GROUP oder COMPANY.');
        data.serialScope = scope;
    }
    if (patch.serialYearlyReset !== undefined)
        data.serialYearlyReset = Boolean(patch.serialYearlyReset);
    if (patch.variantRules !== undefined) {
        const rules = patch.variantRules || {};
        data.variantRules = { ip: Boolean(rules.ip), voltage: Boolean(rules.voltage), custom: Boolean(rules.custom) };
    }
    if (data.serialDigits !== undefined && data.serialDigits !== null) {
        data.serialDigits = Math.min(9, Math.max(3, Math.trunc(data.serialDigits)));
    }
    return (await prisma_client_1.default.panelSettings.update({ where: { tenantId }, data }));
};
exports.savePanelSettings = savePanelSettings;
/**
 * FRAGE 3 — in wessen Reihe diese Firma zählt. GROUP: die Wurzel des
 * Firmenbaums (eine einzige OffiTec-Serie); COMPANY: die Firma selbst.
 */
const serialScopeTenantId = async (tenantId, settings) => {
    if (String(settings.serialScope || 'GROUP').toUpperCase() !== 'GROUP')
        return tenantId;
    return (await (0, tenantTree_1.findTenantRootIdCached)(tenantId)) || tenantId;
};
exports.serialScopeTenantId = serialScopeTenantId;
/* ── TYPENFAMILIEN ──────────────────────────────────────────────────────────*/
/** Beim ersten Öffnen legt sich der Vorschlagskatalog selbst an. */
const ensureTypeFamilies = async (tenantId) => {
    const count = await prisma_client_1.default.panelTypeFamily.count({ where: { tenantId } });
    if (count > 0)
        return;
    await prisma_client_1.default.panelTypeFamily.createMany({
        data: exports.DEFAULT_TYPE_FAMILIES.map((family, index) => ({
            id: (0, nanoid_1.nanoid)(12),
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
exports.ensureTypeFamilies = ensureTypeFamilies;
const listTypeFamilies = async (tenantId, options = {}) => {
    await (0, exports.ensureTypeFamilies)(tenantId);
    return prisma_client_1.default.panelTypeFamily.findMany({
        where: { tenantId, ...(options.activeOnly ? { isActive: true } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
};
exports.listTypeFamilies = listTypeFamilies;
const saveTypeFamily = async (tenantId, id, input) => {
    const code = (0, panelModelNumber_1.normalizePanelCode)(input.code, 4);
    if (!(0, panelModelNumber_1.isValidFamilyCode)(code))
        throw fail(400, 'BAD_FAMILY_CODE', 'Kürzel: 2–4 Grossbuchstaben oder Ziffern.');
    const name = String(input.name || '').trim();
    if (!name)
        throw fail(400, 'NAME_REQUIRED', 'Die Familie braucht einen Namen.');
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
            const existing = await prisma_client_1.default.panelTypeFamily.findFirst({ where: { id, tenantId } });
            if (!existing)
                throw fail(404, 'FAMILY_NOT_FOUND', 'Typenfamilie nicht gefunden.');
            // Das Kürzel steckt in jeder schon gebildeten Modellnummer — es zu
            // ändern hiesse, vergebene Nummern umzuschreiben.
            if (existing.code !== code) {
                const used = await prisma_client_1.default.panelModel.count({ where: { tenantId, typeFamilyId: id } });
                if (used > 0)
                    throw fail(409, 'FAMILY_CODE_LOCKED', `«${existing.code}» steht schon auf ${used} Modellnummer(n) und kann nicht mehr geändert werden.`);
            }
            return await prisma_client_1.default.panelTypeFamily.update({ where: { id }, data });
        }
        return await prisma_client_1.default.panelTypeFamily.create({ data: { id: (0, nanoid_1.nanoid)(12), ...data } });
    }
    catch (error) {
        if (error?.code === 'P2002')
            throw fail(409, 'FAMILY_CODE_TAKEN', `Das Kürzel «${code}» gibt es schon.`);
        throw error;
    }
};
exports.saveTypeFamily = saveTypeFamily;
const deleteTypeFamily = async (tenantId, id) => {
    const used = await prisma_client_1.default.panelModel.count({ where: { tenantId, typeFamilyId: id } });
    if (used > 0)
        throw fail(409, 'FAMILY_IN_USE', `Zu dieser Familie gehören ${used} Modell(e); sie kann nur stillgelegt werden.`);
    await prisma_client_1.default.panelTypeFamily.deleteMany({ where: { id, tenantId } });
};
exports.deleteTypeFamily = deleteTypeFamily;
/** Die Bezeichnung der Produktkarte, wenn keine getippt wurde. */
const defaultModelName = (family, input) => {
    const unit = (0, panelModelNumber_1.ratingUnitLabel)(family.ratingUnit);
    const rating = unit ? ` ${Math.trunc(input.ratingValue)} ${unit}` : '';
    return `${family.name}${rating}`.trim();
};
/**
 * Ein neues MODELL: Produktkarte (mit ERP-Code aus dem Nummernkreis) plus
 * Typenschildwerte. Die Modellnummer wird gebildet und ist eindeutig — gleiche
 * Technik zweimal anzulegen, lehnt der Schlüssel ab.
 */
const createPanelModel = async (tenantId, input, userId) => {
    const settings = await (0, exports.ensurePanelSettings)(tenantId);
    await (0, exports.ensureTypeFamilies)(tenantId);
    const family = await prisma_client_1.default.panelTypeFamily.findFirst({ where: { id: String(input.typeFamilyId || ''), tenantId } });
    if (!family)
        throw fail(404, 'FAMILY_NOT_FOUND', 'Typenfamilie nicht gefunden.');
    if (!family.isActive)
        throw fail(409, 'FAMILY_INACTIVE', 'Diese Typenfamilie ist stillgelegt.');
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
        throw fail(400, 'RATING_REQUIRED', `Die Leistungsklasse (${(0, panelModelNumber_1.ratingUnitLabel)(family.ratingUnit)}) fehlt.`);
    }
    const variantCode = input.variantCode ? (0, panelModelNumber_1.normalizePanelCode)(input.variantCode, 8) : '';
    if (variantCode && !(0, panelModelNumber_1.isValidVariantCode)(variantCode)) {
        throw fail(400, 'BAD_VARIANT', 'Variantenkürzel: 1–8 Grossbuchstaben oder Ziffern.');
    }
    // FRAGE 5 — braucht dieses Modell überhaupt ein Kürzel?
    const reasons = (0, panelModelNumber_1.variantRequiredReasons)(settings.variantRules, { ipRating: settings.defaultIpRating, ratedVoltage: settings.defaultVoltage }, {
        ipRating: input.ipRating,
        ratedVoltage: input.ratedVoltage ?? null,
        hasCustomDeviation: input.hasCustomDeviation,
        variantCode,
    });
    if (reasons.length && !variantCode) {
        throw Object.assign(new Error('Dieses Modell weicht von der Hausnorm ab und braucht ein Variantenkürzel.'), { status: 409, code: 'VARIANT_REQUIRED', details: { reasons } });
    }
    const modelNumber = (0, panelModelNumber_1.formatPanelModelNumber)({
        prefix: settings.modelPrefix,
        typeCode: family.code,
        ratingValue,
        variantCode,
    });
    const taken = await prisma_client_1.default.panelModel.findFirst({
        where: { tenantId, modelNumber },
        select: { id: true, articleId: true },
    });
    if (taken) {
        throw Object.assign(new Error(`Die Modellnummer «${modelNumber}» gibt es schon — gleiche Technik ist dasselbe Modell.`), { status: 409, code: 'MODEL_NUMBER_TAKEN', details: { panelModelId: taken.id, articleId: taken.articleId } });
    }
    // Die PRODUKTNUMMER kommt aus dem Nummernkreis der Familie (oder dem
    // mitgegebenen) — derselbe Zähler, der auch das Lager nummeriert.
    const schemeId = String(input.codeSchemeId || family.codeSchemeId || '');
    if (!schemeId) {
        throw fail(409, 'CODE_SCHEME_MISSING', 'Für diese Typenfamilie ist kein Nummernkreis hinterlegt (Einstellungen → Code-Einstellungen).');
    }
    const { codes } = await (0, articleCodeCatalog_1.issueCodes)(tenantId, schemeId, 1);
    const articleCode = codes[0];
    const articleId = (0, nanoid_1.nanoid)(10);
    const panelModelId = (0, nanoid_1.nanoid)(12);
    const name = String(input.name || '').trim() || defaultModelName(family, input);
    const created = await prisma_client_1.default.$transaction(async (tx) => {
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
        await prisma_client_1.default.panelTypeFamily
            .update({ where: { id: family.id }, data: { codeSchemeId: schemeId } })
            .catch(() => undefined);
    }
    return { ...created, articleCode };
};
exports.createPanelModel = createPanelModel;
/** Technische Werte ändern; Nummer und Produktkarte bleiben. */
const updatePanelModel = async (tenantId, id, patch) => {
    const model = await prisma_client_1.default.panelModel.findFirst({ where: { id, tenantId } });
    if (!model)
        throw fail(404, 'MODEL_NOT_FOUND', 'Modell nicht gefunden.');
    const nextName = patch.name !== undefined ? String(patch.name || '').trim() : null;
    if (patch.name !== undefined && !nextName) {
        throw fail(400, 'MODEL_FIELDS_REQUIRED', 'Pano modeli açıklaması zorunludur.');
    }
    const nextValue = (key) => patch[key] !== undefined ? patch[key] : model[key];
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
    const data = {};
    for (const key of ['ratedVoltage', 'ratedCurrent', 'phaseCount', 'frequency', 'shortCircuitIcw', 'shortCircuitTime', 'shortCircuitIpk']) {
        if (patch[key] !== undefined) {
            const value = patch[key] === null || patch[key] === '' ? null : Number(patch[key]);
            if (value !== null && !Number.isFinite(value))
                throw fail(400, 'BAD_NUMBER', `«${key}» muss eine Zahl sein.`);
            data[key] = value;
        }
    }
    if (patch.ipRating !== undefined)
        data.ipRating = patch.ipRating ? String(patch.ipRating).trim().toUpperCase() : null;
    if (patch.standard !== undefined)
        data.standard = patch.standard ? String(patch.standard).trim() : null;
    if (patch.ceMarking !== undefined)
        data.ceMarking = Boolean(patch.ceMarking);
    if (patch.notes !== undefined)
        data.notes = patch.notes ? String(patch.notes) : null;
    if (patch.isActive !== undefined)
        data.isActive = Boolean(patch.isActive);
    const updated = await prisma_client_1.default.panelModel.update({ where: { id }, data });
    if (patch.name !== undefined) {
        await prisma_client_1.default.article.update({ where: { id: model.articleId }, data: { name: nextName } });
    }
    return updated;
};
exports.updatePanelModel = updatePanelModel;
/**
 * DIE EINLAGERUNG EINES GELÖSCHTEN SCHRANKS ZURÜCKNEHMEN — seine `IN`-Bewegung
 * fällt weg und der Bestand geht um dieselbe Menge zurück (dieselbe Regel wie
 * beim gelöschten Wareneingang). Ohne das stünde im Lager ein Stück, dessen
 * Schrank es nicht mehr gibt.
 */
const revertPanelStockMovements = async (tx, tenantId, movementIds) => {
    const ids = movementIds.filter(Boolean).map(String);
    if (!ids.length)
        return;
    const movements = await tx.stockMovement.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, articleId: true, quantity: true, destinationLocationId: true },
    });
    if (!movements.length)
        return;
    await tx.stockMovement.deleteMany({ where: { tenantId, id: { in: movements.map((row) => String(row.id)) } } });
    for (const movement of movements) {
        // Konumsuz hareket bakiye yazmamıştır — geri alacak bir şey de yoktur.
        if (!movement.destinationLocationId)
            continue;
        await tx.$executeRawUnsafe('UPDATE `StockBalance` SET `currentQuantity` = `currentQuantity` - ?, `updatedAt` = NOW(3) '
            + 'WHERE `tenantId` = ? AND `articleId` = ? AND `locationId` = ?', Number(movement.quantity) || 0, tenantId, movement.articleId, movement.destinationLocationId);
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
const deletePanelModel = async (tenantId, id) => {
    const model = await prisma_client_1.default.panelModel.findFirst({ where: { id, tenantId } });
    if (!model)
        throw fail(404, 'MODEL_NOT_FOUND', 'Pano modeli bulunamadı.');
    // Eingelagerte Schränke dieses Modells: ihre Buchungen gehen mit.
    const stocked = await prisma_client_1.default.panelUnit.findMany({
        where: { tenantId, panelModelId: model.id, stockMovementId: { not: null } },
        select: { stockMovementId: true },
    });
    await prisma_client_1.default.$transaction(async (tx) => {
        await revertPanelStockMovements(tx, tenantId, stocked.map((row) => String(row.stockMovementId)));
        await tx.panelUnit.deleteMany({ where: { panelModelId: model.id } });
        await tx.panelModel.delete({ where: { id: model.id } });
        await tx.article.update({
            where: { id: model.articleId },
            data: { deletedAt: new Date(), status: 'INACTIVE', isActive: false },
        });
    });
};
exports.deletePanelModel = deletePanelModel;
/**
 * Was dem Schild noch fehlt. Ein Schild darf NICHT gedruckt werden, solange
 * hier etwas steht — ein unvollständiges Typenschild ist schlimmer als keines.
 * Die Kurzschlussangabe verlangt die FAMILIE (FRAGE 6), nicht der Code.
 */
const missingNameplateFields = (model, _family) => {
    const missing = [];
    if (!model.manufacturer)
        missing.push({ field: 'manufacturer', label: 'Üretici' });
    if (!model.modelNumber)
        missing.push({ field: 'modelNumber', label: 'Model numarası' });
    if (!(Number(model.ratedVoltage) > 0))
        missing.push({ field: 'ratedVoltage', label: 'Anma gerilimi (Ue)' });
    if (!(Number(model.ratedCurrent) > 0))
        missing.push({ field: 'ratedCurrent', label: 'Anma akımı (InA)' });
    if (!(Number(model.phaseCount) > 0))
        missing.push({ field: 'phaseCount', label: 'Faz sayısı' });
    if (!(Number(model.frequency) > 0))
        missing.push({ field: 'frequency', label: 'Frekans' });
    if (!model.ipRating)
        missing.push({ field: 'ipRating', label: 'IP koruma sınıfı' });
    if (!model.standard)
        missing.push({ field: 'standard', label: 'Uygulanan standart' });
    if (!(Number(model.shortCircuitIcw) > 0))
        missing.push({ field: 'shortCircuitIcw', label: 'Kısa devre dayanımı (Icw)' });
    if (!(Number(model.shortCircuitTime) > 0))
        missing.push({ field: 'shortCircuitTime', label: 'Icw süresi' });
    if (!(Number(model.shortCircuitIpk) > 0))
        missing.push({ field: 'shortCircuitIpk', label: 'Tepe kısa devre akımı (Ipk)' });
    return missing;
};
exports.missingNameplateFields = missingNameplateFields;
/** Die eingefrorene Schildkopie eines Schranks. */
const buildNameplate = (model, unit, settings) => ({
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
exports.buildNameplate = buildNameplate;
/** Projekt und Gerät sind freiwillig; ein gewähltes Gerät muss aber zum
 * gewählten Projekt und zur aktuellen Firma gehören. */
const validatePanelProductionLink = async (tenantId, productionProjectId, productionItemId) => {
    const projectId = productionProjectId ? String(productionProjectId) : null;
    const itemId = productionItemId ? String(productionItemId) : null;
    if (!projectId && itemId)
        throw fail(400, 'PANEL_PROJECT_REQUIRED', 'Cihaz bağlantısı için önce proje seçilmelidir.');
    if (!projectId)
        return;
    const project = await prisma_client_1.default.productionProject.findFirst({ where: { id: projectId, tenantId, isActive: true }, select: { id: true } });
    if (!project)
        throw fail(404, 'PROJECT_NOT_FOUND', 'Üretim projesi bulunamadı.');
    if (!itemId)
        return;
    const item = await prisma_client_1.default.productionProjectItem.findFirst({
        where: { id: itemId, tenantId, productionProjectId: projectId, isActive: true, kind: 'DEVICE' },
        select: { id: true },
    });
    if (!item)
        throw fail(400, 'PANEL_DEVICE_INVALID', 'Seçilen cihaz bu projeye ait değil.');
};
/**
 * `count` Seriennummern für ein Modell — der Augenblick, in dem aus einem Typ
 * einzelne Schränke werden. Absichtlich VOR dem Schaltplan: die Nummer soll im
 * Plan stehen (Vorgabe Baris).
 */
const issuePanelUnits = async (tenantId, input, userId) => {
    const settings = await (0, exports.ensurePanelSettings)(tenantId);
    const model = await prisma_client_1.default.panelModel.findFirst({
        where: { id: String(input.panelModelId || ''), tenantId },
        include: { typeFamily: true },
    });
    if (!model)
        throw fail(404, 'MODEL_NOT_FOUND', 'Modell nicht gefunden.');
    if (!model.isActive)
        throw fail(409, 'MODEL_INACTIVE', 'Dieses Modell ist stillgelegt.');
    await validatePanelProductionLink(tenantId, input.productionProjectId, input.productionItemId);
    const count = Math.max(1, Math.min(200, Math.trunc(Number(input.count) || 1)));
    const year = Math.trunc(Number(input.year) || new Date().getFullYear());
    const scopeTenantId = await (0, exports.serialScopeTenantId)(tenantId, settings);
    const serialOptions = {
        year,
        digits: settings.serialDigits,
        yearlyReset: settings.serialYearlyReset,
        retro: Boolean(input.retro),
        retroBlockStart: settings.retroBlockStart,
    };
    // Ziehen und Anlegen in EINER Transaktion: bricht etwas ab, ist auch keine
    // Nummer vergeben.
    return prisma_client_1.default.$transaction(async (tx) => {
        const serials = await (0, panelSerial_1.nextPanelSerials)(scopeTenantId, count, serialOptions, tx);
        const rows = serials.map((serial) => ({
            id: (0, nanoid_1.nanoid)(12),
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
exports.issuePanelUnits = issuePanelUnits;
/** Der Lebenslauf eines Schranks — jede Stufe darf nur vorwärts oder zurück zu «abgebrochen». */
exports.PANEL_UNIT_STATUS = ['PLANNED', 'IN_PRODUCTION', 'TESTED', 'STOCKED', 'RESERVED', 'SHIPPED', 'INSTALLED', 'CANCELLED'];
/* ── DER SCHRANK GEHT INS LAGER ─────────────────────────────────────────────
 *
 * Das Gegenstück zum Wareneingang: dort löst eine Lieferantenbestellung die
 * Buchung aus, hier die fertige Produktion. Gebucht wird über die PRODUKTKARTE
 * DES MODELLS (Menge 1) — es entsteht KEINE eigene Produktkarte je Schrank;
 * welcher Schrank es war, sagt `StockMovement.serialNumber`.
 */
const stockInPanelUnit = async (tenantId, unitId, employeeId, options = {}) => {
    const unit = await prisma_client_1.default.panelUnit.findFirst({ where: { id: unitId, tenantId }, include: { model: true } });
    if (!unit)
        throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    if (unit.status === 'CANCELLED')
        throw fail(409, 'UNIT_CANCELLED', 'Dieser Schrank ist storniert.');
    if (unit.stockMovementId)
        throw fail(409, 'ALREADY_STOCKED', 'Dieser Schrank ist schon im Lager gebucht.');
    const articleId = unit.articleId || unit.model?.articleId;
    if (!articleId)
        throw fail(409, 'ARTICLE_MISSING', 'Dem Modell fehlt seine Produktkarte.');
    const location = await new InventoryRepository_1.InventoryRepository().ensureDefaultLocation(tenantId);
    const movementId = (0, nanoid_1.nanoid)(12);
    const now = new Date();
    await prisma_client_1.default.$transaction(async (tx) => {
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
        await tx.$executeRawUnsafe('INSERT INTO `StockBalance` (`id`, `tenantId`, `articleId`, `locationId`, `currentQuantity`, `reservedQuantity`, `updatedAt`) '
            + 'VALUES (?, ?, ?, ?, 1, 0, NOW(3)) '
            + 'ON DUPLICATE KEY UPDATE `currentQuantity` = `currentQuantity` + 1, `updatedAt` = NOW(3)', (0, nanoid_1.nanoid)(10), tenantId, articleId, location.id);
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
    return prisma_client_1.default.panelUnit.findFirst({ where: { id: unit.id }, include: { model: true } });
};
exports.stockInPanelUnit = stockInPanelUnit;
/**
 * ETIKETT DRUCKEN — friert die Schildwerte auf dem Schrank ein. Danach ist der
 * Satz das, was wirklich am Schrank klebt; spätere Modelländerungen berühren
 * ihn nicht mehr (dieselbe Regel wie die Spaltenkopie der Bestell-PDFs).
 *
 * Fehlt ein Pflichtwert, wird NICHT gedruckt: ein halbes Typenschild ist
 * schlimmer als keines (`NAMEPLATE_INCOMPLETE` nennt die fehlenden Felder).
 */
const freezeNameplate = async (tenantId, unitId, userId) => {
    const settings = await (0, exports.ensurePanelSettings)(tenantId);
    const unit = await prisma_client_1.default.panelUnit.findFirst({
        where: { id: unitId, tenantId },
        include: { model: { include: { typeFamily: true } } },
    });
    if (!unit)
        throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    if (unit.status === 'CANCELLED')
        throw fail(409, 'UNIT_CANCELLED', 'Dieser Schrank ist storniert.');
    const missing = (0, exports.missingNameplateFields)(unit.model, unit.model?.typeFamily);
    if (missing.length) {
        throw Object.assign(new Error('Dem Typenschild fehlen Pflichtangaben.'), { status: 409, code: 'NAMEPLATE_INCOMPLETE', details: { missing } });
    }
    const nameplate = (0, exports.buildNameplate)(unit.model, unit, settings);
    const updated = await prisma_client_1.default.panelUnit.update({
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
exports.freezeNameplate = freezeNameplate;
/**
 * Stufenwechsel. Vorwärts ist frei, zurück nicht — nur «abgebrochen» ist von
 * überall erreichbar, und eine abgebrochene Nummer wird NIE neu vergeben
 * (die Zeile bleibt stehen, damit die Serie lückenlos nachvollziehbar ist).
 */
const setPanelUnitStatus = async (tenantId, unitId, status, userId) => {
    const next = String(status || '').toUpperCase();
    if (!exports.PANEL_UNIT_STATUS.includes(next))
        throw fail(400, 'BAD_STATUS', 'Unbekannte Stufe.');
    const unit = await prisma_client_1.default.panelUnit.findFirst({ where: { id: unitId, tenantId } });
    if (!unit)
        throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    if (unit.status === next)
        return unit;
    if (unit.status === 'CANCELLED')
        throw fail(409, 'UNIT_CANCELLED', 'Ein stornierter Schrank wird nicht wiederbelebt.');
    const order = exports.PANEL_UNIT_STATUS.indexOf(unit.status);
    const target = exports.PANEL_UNIT_STATUS.indexOf(next);
    if (next !== 'CANCELLED' && target < order) {
        throw fail(409, 'STATUS_BACKWARDS', 'Eine Stufe geht nicht zurück.');
    }
    const settings = await (0, exports.ensurePanelSettings)(tenantId);
    const now = new Date();
    const data = { status: next };
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
    return prisma_client_1.default.panelUnit.update({ where: { id: unit.id }, data });
};
exports.setPanelUnitStatus = setPanelUnitStatus;
/** Schrankdaten pflegen: Schaltplan, Kunde, Baustelle, Notiz, Daten. */
const updatePanelUnit = async (tenantId, unitId, patch) => {
    const unit = await prisma_client_1.default.panelUnit.findFirst({ where: { id: unitId, tenantId } });
    if (!unit)
        throw fail(404, 'UNIT_NOT_FOUND', 'Schaltschrank nicht gefunden.');
    const linkedProjectId = patch.productionProjectId !== undefined
        ? (patch.productionProjectId ? String(patch.productionProjectId) : null)
        : unit.productionProjectId;
    const linkedItemId = patch.productionItemId !== undefined
        ? (patch.productionItemId ? String(patch.productionItemId) : null)
        : unit.productionItemId;
    await validatePanelProductionLink(tenantId, linkedProjectId, linkedItemId);
    const data = {};
    for (const key of ['schemaNumber', 'schemaRevision', 'schemaFileUrl', 'customerName', 'siteName', 'orderNumber', 'notes']) {
        if (patch[key] !== undefined)
            data[key] = patch[key] ? String(patch[key]).trim() : null;
    }
    for (const key of ['productionProjectId', 'productionItemId', 'projectId', 'salesOrderId', 'customerId']) {
        if (patch[key] !== undefined)
            data[key] = patch[key] ? String(patch[key]) : null;
    }
    for (const key of ['manufacturedAt', 'testedAt', 'deliveredAt', 'warrantyUntil']) {
        if (patch[key] !== undefined)
            data[key] = patch[key] ? new Date(patch[key]) : null;
    }
    if (patch.productionYear !== undefined) {
        const year = Number(patch.productionYear);
        data.productionYear = Number.isFinite(year) && year > 1900 ? Math.trunc(year) : null;
    }
    return prisma_client_1.default.panelUnit.update({ where: { id: unit.id }, data });
};
exports.updatePanelUnit = updatePanelUnit;
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
const deletePanelUnit = async (tenantId, unitId) => {
    const unit = await prisma_client_1.default.panelUnit.findFirst({ where: { id: unitId, tenantId } });
    if (!unit)
        throw fail(404, 'UNIT_NOT_FOUND', 'Pano bulunamadı.');
    await prisma_client_1.default.$transaction(async (tx) => {
        // Liegt der Schrank im Lager, wird SEINE Einlagerung zurückgenommen.
        await revertPanelStockMovements(tx, tenantId, unit.stockMovementId ? [String(unit.stockMovementId)] : []);
        await tx.panelUnit.delete({ where: { id: unit.id } });
    });
};
exports.deletePanelUnit = deletePanelUnit;
/**
 * DIE SUCHE ÜBER DIE SERIENNUMMER — der Weg, den Baris im Sinn hat: Etikett
 * lesen (oder QR scannen), alles andere findet sich. Gesucht wird im ganzen
 * Seriennummern-Bereich, nicht nur in der eigenen Firma.
 */
const findPanelBySerial = async (tenantId, serialNumber) => {
    const settings = await (0, exports.ensurePanelSettings)(tenantId);
    const scopeTenantId = await (0, exports.serialScopeTenantId)(tenantId, settings);
    const serial = String(serialNumber || '').trim();
    if (!serial)
        return null;
    return prisma_client_1.default.panelUnit.findFirst({
        where: { serialTenantId: scopeTenantId, serialNumber: serial },
        include: { model: { include: { typeFamily: true } } },
    });
};
exports.findPanelBySerial = findPanelBySerial;
//# sourceMappingURL=panelCatalog.js.map