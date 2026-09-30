import type { ISupplierEmailBook } from '../../../domain/repositories/ISupplierEmailBook';
import type {
    IWarehouseDirectory,
    IWarehouseGroupRepository,
    IWarehouseImportRepository,
    IWarehouseNotifier,
    IWarehouseProductRepository,
} from '../../../domain/repositories/IWarehouseRepository';
import type {
    WarehouseImportCreate,
    WarehouseImportIssue,
    WarehouseImportRow,
    WarehouseMaterialGroup,
    WarehouseProductFields,
} from '../../../domain/entities/Warehouse';
import { cleanLine, draftStateOf, warehouseError } from '../../../domain/services/warehouse';
import {
    codeVariants,
    groupTextKey,
    IMPORT_MAX_ROWS,
    importRowFromInput,
    importRowHasContent,
} from '../../../domain/services/warehouseCodes';
import {
    groupLabel,
    importSummaryDto,
    type WarehouseImportDetailDto,
    type WarehouseImportRowDto,
    type WarehouseImportSummaryDto,
} from './warehouseReadModel';

export interface WarehouseActor {
    id: string;
    name: string | null;
    isSystemAdmin: boolean;
}

const lower = (value: string) => value.trim().toLocaleLowerCase('tr-TR');

/** Gruppentext → Gruppe: Kürzelpaar (ELK-PLC), «Kategorie › Gruppe», eindeutiger Gruppenname oder -kürzel. */
const groupResolver = (groups: WarehouseMaterialGroup[]) => {
    const byId = new Map(groups.map((group) => [group.id, group]));
    const byPair = new Map<string, WarehouseMaterialGroup>();
    const byLabel = new Map<string, WarehouseMaterialGroup>();
    const byName = new Map<string, WarehouseMaterialGroup[]>();
    const byCode = new Map<string, WarehouseMaterialGroup[]>();
    for (const group of groups) {
        if (group.code) {
            byPair.set(`${group.categoryCode}-${group.code}`, group);
            const list = byCode.get(group.code) ?? [];
            list.push(group);
            byCode.set(group.code, list);
        }
        byLabel.set(lower(groupLabel(group)), group);
        for (const separator of ['›', '>', '/', '-', ':']) {
            byLabel.set(lower(`${group.categoryName} ${separator} ${group.name}`), group);
        }
        const named = byName.get(lower(group.name)) ?? [];
        named.push(group);
        byName.set(lower(group.name), named);
    }
    return (text: string | null, id?: string | null): WarehouseMaterialGroup | null => {
        if (id && byId.has(id)) return byId.get(id) ?? null;
        if (!text) return null;
        const key = groupTextKey(text);
        if (key.pair && byPair.has(key.pair)) return byPair.get(key.pair) ?? null;
        const label = byLabel.get(lower(text));
        if (label) return label;
        const named = byName.get(lower(text));
        if (named?.length === 1) return named[0] ?? null;
        const coded = byCode.get(text.trim().toUpperCase());
        if (coded?.length === 1) return coded[0] ?? null;
        return null;
    };
};

/**
 * ── EXCEL-AKTARIM MIT FREIGABE (26.09.2026, Vorgabe Samet) ──────────────────
 *
 * «Bana Excel örneği indirme yeri olması lazım … malzeme grubu seçilebilir
 *  olması lazım. Bir de biz bunları aktarmamız lazım, ama her aktarımdan önce
 *  toplu aktarım administratöre izin gitmesi lazım — Excel seçim aktarılacak
 *  ama izin bekleniyor; izin verildiğinde olması lazım: aktarılsın mı diye?»
 *
 *   1. Vorschau   Die Oberfläche liest die Datei und schickt die Zeilen; der
 *                 Server prüft jede (Name, Zahlen, Gruppe, Barcode) — nichts
 *                 wird gespeichert.
 *   2. Einreichen Die fehlerfreien Zeilen warten als Aktarım (PENDING); jede
 *                 Person mit der Administratorrolle bekommt die Glocke.
 *   3. Freigabe   Nur die Administratorrolle: «Aktarılsın mı?» — die Zeilen
 *                 werden JETZT noch einmal geprüft (eine Gruppe kann inzwischen
 *                 fehlen), die guten werden Karten mit ERP-Code und Barcode.
 *      Ablehnen   mit Grund; Zurückziehen kann die einreichende Person.
 */
export class WarehouseImportsUseCase {
    constructor(
        private imports: IWarehouseImportRepository,
        private groups: IWarehouseGroupRepository,
        private products: IWarehouseProductRepository,
        private directory: IWarehouseDirectory,
        private notifier: IWarehouseNotifier,
        /** Die Lieferantenliste als Adressbuch (30.09.2026): Adressen aus dem Import werden die der Lieferanten. */
        private emails: ISupplierEmailBook | null = null,
    ) {}

    /** Zeilen prüfen, ohne etwas zu speichern. */
    async preview(tenantId: string, body: unknown): Promise<{ rows: WarehouseImportRowDto[]; valid: number; invalid: number; warnings: number }> {
        const rows = await this.parse(tenantId, (body as { rows?: unknown } | null)?.rows);
        return { rows, ...this.counts(rows) };
    }

    /** Die fehlerfreien Zeilen einreichen — sie warten auf die Freigabe. */
    async request(
        tenantId: string,
        actor: WarehouseActor,
        body: unknown,
    ): Promise<{ import: WarehouseImportSummaryDto; skipped: number }> {
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const rows = await this.parse(tenantId, input.rows);
        const valid = rows.filter((row) => !row.issues.some((issue) => issue.level === 'error'));
        if (!valid.length) {
            throw warehouseError('IMPORT_NOTHING_VALID', 'Keine Zeile ist fehlerfrei.', { status: 400 });
        }
        const fileName = cleanLine(input.fileName, 'fileName', 255);
        const stored: WarehouseImportRow[] = valid.map((row) => ({
            row: row.row,
            group: row.groupLabel ?? row.group,
            groupId: row.groupId,
            name: row.name,
            brand: row.brand,
            modelNumber: row.modelNumber,
            productCode: row.productCode ?? null,
            unit: row.unit ?? null,
            supplierName: row.supplierName,
            supplierEmail: row.supplierEmail ?? null,
            description: row.description,
            quantity: row.quantity,
            purchasePrice: row.purchasePrice,
            currency: row.currency,
            manufacturerBarcode: row.manufacturerBarcode,
            serialRequired: row.serialRequired,
        }));
        const created = await this.imports.create(tenantId, {
            fileName,
            rows: stored,
            requestedById: actor.id,
            requestedByName: actor.name,
        });
        await this.notifier.importRequested({
            tenantId,
            importId: created.id,
            rowCount: created.rowCount,
            fileName,
            actorId: actor.id,
            actorName: actor.name,
        });
        return { import: importSummaryDto(created), skipped: rows.length - valid.length };
    }

    async list(tenantId: string): Promise<{ items: WarehouseImportSummaryDto[]; pendingCount: number }> {
        const [items, pendingCount] = await Promise.all([
            this.imports.list(tenantId, 50),
            this.imports.pendingCount(tenantId),
        ]);
        return { items: items.map(importSummaryDto), pendingCount };
    }

    /** Ein Aktarım mit seinen Zeilen — geprüft gegen den Stand von JETZT. */
    async get(tenantId: string, id: string): Promise<WarehouseImportDetailDto> {
        const entry = await this.imports.get(tenantId, id);
        if (!entry) throw warehouseError('IMPORT_NOT_FOUND', 'Aktarım nicht gefunden.', { status: 404 });
        const rows = entry.status === 'PENDING'
            ? await this.check(tenantId, entry.rows)
            : entry.rows.map((row) => ({ ...row, groupId: row.groupId ?? null, groupLabel: row.group, issues: [] }));
        return { ...importSummaryDto(entry), rows };
    }

    /** «Aktarılsın mı?» — Ja: die fehlerfreien Zeilen werden Karten. */
    async approve(
        tenantId: string,
        actor: WarehouseActor,
        id: string,
    ): Promise<{ import: WarehouseImportSummaryDto; result: NonNullable<WarehouseImportSummaryDto['result']> }> {
        if (!actor.isSystemAdmin) throw this.forbidden();
        const entry = await this.imports.get(tenantId, id);
        if (!entry) throw warehouseError('IMPORT_NOT_FOUND', 'Aktarım nicht gefunden.', { status: 404 });
        if (entry.status !== 'PENDING') throw this.notPending(entry.status);

        const rows = await this.check(tenantId, entry.rows);
        const suppliers = await this.directory.suppliersByName(
            tenantId,
            rows.map((row) => row.supplierName).filter((name): name is string => Boolean(name)),
        );
        const creates: WarehouseImportCreate[] = [];
        const failed: Array<{ row: number; code: string }> = [];
        for (const row of rows) {
            const error = row.issues.find((issue) => issue.level === 'error');
            if (error) {
                failed.push({ row: row.row, code: error.code });
                continue;
            }
            const supplier = row.supplierName ? suppliers.get(lower(row.supplierName)) : undefined;
            // Der Herstellerbarcode der Zeile gehört ihrem Lieferanten (vierter
            // Durchgang: «tedarikçiye göre ürün barkodu»); ohne Lieferant der Karte.
            const fields: WarehouseProductFields = {
                erpCode: null,
                materialGroupId: row.groupId,
                name: row.name,
                brand: row.brand,
                modelNumber: row.modelNumber,
                suppliers: row.supplierName
                    ? [{ supplierId: supplier?.id ?? null, name: supplier?.name ?? row.supplierName, barcode: row.manufacturerBarcode, email: row.supplierEmail ?? null }]
                    : [],
                productCode: row.productCode ?? null,
                unit: row.unit ?? null,
                isDraft: false,
                description: row.description,
                quantity: row.serialRequired ? 0 : row.quantity,
                purchasePrice: row.purchasePrice,
                minimumOrderQuantity: null,
                currency: row.currency,
                barcode: null,
                manufacturerBarcode: row.supplierName ? null : row.manufacturerBarcode,
                serialRequired: row.serialRequired,
            };
            // Was einer fertigen Karte fehlt (Einheit, E-Mail des Lieferanten), macht sie zum Taslak (30.09.2026).
            fields.isDraft = draftStateOf(fields, undefined, null);
            creates.push({ row: row.row, fields });
        }
        if (!creates.length) {
            throw warehouseError('IMPORT_NOTHING_VALID', 'Keine Zeile ist mehr fehlerfrei.', { status: 409 });
        }

        const result = await this.imports.execute(tenantId, id, {
            creates,
            failed,
            decidedById: actor.id,
            decidedByName: actor.name,
            createdById: entry.requestedById ?? actor.id,
        });
        if (!result) {
            const now = await this.imports.get(tenantId, id);
            throw this.notPending(now?.status ?? 'DONE');
        }
        if (this.emails) {
            await this.emails.remember(tenantId, creates.flatMap((create) => create.fields.suppliers
                .map((entry) => ({ supplierId: entry.supplierId, name: entry.name, email: entry.email }))))
                .catch((error: unknown) => console.warn('[depo] Lieferanten-E-Mail (Import) nicht gemerkt:', (error as Error)?.message));
        }
        await this.notifier.importDecided({
            tenantId,
            importId: id,
            requesterId: entry.requestedById,
            outcome: 'DONE',
            actorId: actor.id,
            actorName: actor.name,
            created: result.created,
            note: null,
        });
        const after = await this.imports.get(tenantId, id);
        return { import: importSummaryDto(after ?? entry), result };
    }

    async reject(tenantId: string, actor: WarehouseActor, id: string, body: unknown): Promise<{ import: WarehouseImportSummaryDto }> {
        if (!actor.isSystemAdmin) throw this.forbidden();
        const note = cleanLine((body as { note?: unknown } | null)?.note, 'note', 500);
        return this.close(tenantId, actor, id, 'REJECTED', note);
    }

    /** Zurückziehen: die einreichende Person oder die Verwaltung, solange er wartet. */
    async cancel(tenantId: string, actor: WarehouseActor, id: string): Promise<{ import: WarehouseImportSummaryDto }> {
        const entry = await this.imports.get(tenantId, id);
        if (!entry) throw warehouseError('IMPORT_NOT_FOUND', 'Aktarım nicht gefunden.', { status: 404 });
        if (entry.requestedById !== actor.id && !actor.isSystemAdmin) throw this.forbidden();
        return this.close(tenantId, actor, id, 'CANCELLED', null);
    }

    /* ── Hilfen ─────────────────────────────────────────────────────────── */

    private async close(
        tenantId: string,
        actor: WarehouseActor,
        id: string,
        status: 'REJECTED' | 'CANCELLED',
        note: string | null,
    ): Promise<{ import: WarehouseImportSummaryDto }> {
        const entry = await this.imports.get(tenantId, id);
        if (!entry) throw warehouseError('IMPORT_NOT_FOUND', 'Aktarım nicht gefunden.', { status: 404 });
        if (entry.status !== 'PENDING') throw this.notPending(entry.status);
        const closed = await this.imports.close(tenantId, id, { status, decidedById: actor.id, decidedByName: actor.name, note });
        if (!closed) {
            const now = await this.imports.get(tenantId, id);
            throw this.notPending(now?.status ?? status);
        }
        if (status === 'REJECTED') {
            await this.notifier.importDecided({
                tenantId,
                importId: id,
                requesterId: entry.requestedById,
                outcome: 'REJECTED',
                actorId: actor.id,
                actorName: actor.name,
                created: 0,
                note,
            });
        }
        const after = await this.imports.get(tenantId, id);
        return { import: importSummaryDto(after ?? entry) };
    }

    private forbidden() {
        return warehouseError('IMPORT_FORBIDDEN', 'Nur die Verwaltung kann einen Aktarım freigeben oder ablehnen.', { status: 403 });
    }

    private notPending(status: string) {
        return warehouseError('IMPORT_NOT_PENDING', 'Über diesen Aktarım ist schon entschieden.', {
            status: 409,
            params: { status },
        });
    }

    private counts(rows: WarehouseImportRowDto[]) {
        const invalid = rows.filter((row) => row.issues.some((issue) => issue.level === 'error')).length;
        const warnings = rows.filter((row) => row.issues.some((issue) => issue.level === 'warning')).length;
        return { valid: rows.length - invalid, invalid, warnings };
    }

    /** Rohe Zeilen der Datei → bereinigt + geprüft. */
    private async parse(tenantId: string, raw: unknown): Promise<WarehouseImportRowDto[]> {
        const list = Array.isArray(raw) ? raw.filter(importRowHasContent) : [];
        if (!list.length) throw warehouseError('IMPORT_EMPTY', 'Die Datei enthält keine Zeilen.');
        if (list.length > IMPORT_MAX_ROWS) {
            throw warehouseError('IMPORT_TOO_MANY_ROWS', 'Zu viele Zeilen in einem Aktarım.', {
                params: { max: IMPORT_MAX_ROWS, count: list.length },
            });
        }
        const parsed = list.map((entry, index) => importRowFromInput(entry, index + 2));
        return this.check(tenantId, parsed.map((entry) => entry.row), parsed.map((entry) => entry.issues));
    }

    /** Was nur die Datenbank weiss: Gruppe, fremder Barcode, gleiche Namen. */
    private async check(
        tenantId: string,
        rows: WarehouseImportRow[],
        baseIssues: WarehouseImportIssue[][] = [],
    ): Promise<WarehouseImportRowDto[]> {
        const makerCodes = rows.map((row) => row.manufacturerBarcode).filter((code): code is string => Boolean(code));
        const [groups, names, barcodes, makers] = await Promise.all([
            this.groups.listGroups(tenantId),
            this.products.existingNames(tenantId, rows.map((row) => row.name)),
            this.products.ownBarcodes(tenantId, makerCodes),
            this.products.manufacturerBarcodeOwners(tenantId, makerCodes),
        ]);
        const resolve = groupResolver(groups);
        const firstRowOf = new Map<string, number>();
        // Ein Herstellerbarcode gehört genau EINER Karte — auch innerhalb der Datei.
        const makerRowOf = new Map<string, number>();

        return rows.map((row, index) => {
            const issues: WarehouseImportIssue[] = [...(baseIssues[index] ?? [])];
            let group: WarehouseMaterialGroup | null = null;
            if (row.group || row.groupId) {
                group = resolve(row.group, row.groupId);
                if (!group) {
                    issues.push({ level: 'error', code: 'GROUP_UNKNOWN', field: 'group', params: { group: row.group ?? '' } });
                } else if (!group.code) {
                    issues.push({ level: 'error', code: 'GROUP_CODE_MISSING', field: 'group', params: { group: group.name } });
                }
            }
            if (row.manufacturerBarcode) {
                const owner = codeVariants(row.manufacturerBarcode)
                    .map((variant) => barcodes.get(variant.toLocaleLowerCase('de-CH')))
                    .find(Boolean);
                if (owner) {
                    issues.push({
                        level: 'error',
                        code: 'BARCODE_TAKEN',
                        field: 'manufacturerBarcode',
                        params: { code: row.manufacturerBarcode, name: owner },
                    });
                }
                const holder = codeVariants(row.manufacturerBarcode)
                    .map((variant) => makers.get(variant.toLocaleLowerCase('de-CH')))
                    .find(Boolean);
                if (holder) {
                    issues.push({
                        level: 'error',
                        code: 'MANUFACTURER_BARCODE_TAKEN',
                        field: 'manufacturerBarcode',
                        params: { code: row.manufacturerBarcode, name: holder },
                    });
                }
                const earlier = codeVariants(row.manufacturerBarcode)
                    .map((variant) => makerRowOf.get(variant.toLocaleLowerCase('de-CH')))
                    .find((value) => value !== undefined);
                if (earlier !== undefined) {
                    issues.push({
                        level: 'error',
                        code: 'MANUFACTURER_BARCODE_DUPLICATE',
                        field: 'manufacturerBarcode',
                        params: { code: row.manufacturerBarcode, row: earlier },
                    });
                } else {
                    for (const variant of codeVariants(row.manufacturerBarcode)) makerRowOf.set(variant.toLocaleLowerCase('de-CH'), row.row);
                }
            }
            if (row.name && names.has(lower(row.name))) {
                issues.push({ level: 'warning', code: 'DUPLICATE_NAME', field: 'name', params: { name: row.name } });
            }
            const key = [row.name, row.brand, row.modelNumber, row.manufacturerBarcode].map((part) => lower(part ?? '')).join('|');
            const first = firstRowOf.get(key);
            if (row.name && first !== undefined) {
                issues.push({ level: 'warning', code: 'DUPLICATE_ROW', field: 'name', params: { row: first } });
            } else if (row.name) {
                firstRowOf.set(key, row.row);
            }
            return {
                ...row,
                groupId: group?.id ?? null,
                groupLabel: group ? groupLabel(group) : null,
                issues,
            };
        });
    }
}
