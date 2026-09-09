import { MAX_LINE_DISCOUNTS, normalizeDiscountList, parseDiscountList, remainingAfterDiscounts } from '../../presentation/controllers/tender.discounts';

type Input = {
    id?: string | null; kind?: string; articleId?: string | null; materialId?: string | null;
    quantity?: number | string | null; unitPrice?: number | string | null; amount?: number | string | null;
    description?: string | null; longDescription?: string | null; unit?: string | null; discounts?: unknown;
};
export interface AddonLineMetadata {
    description: string; quantity: number; unitPrice: number; unit: string;
    discounts: ReturnType<typeof parseDiscountList>; sortOrder: number;
}
type Product = { id: string | null; articleId: string; quantity: number; unitPrice: number | null; description: string | null; metadata: AddonLineMetadata };
type TextLine = { id: string | null; description: string; longDescription: string | null; amount: number; documentLine: string };
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const number = (value: unknown, label: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} ungültig.`);
    return parsed;
};

/** The project ledger stores the discounted amount; metadata preserves the editable document. */
export function normalizeAddonLines(raw: unknown): { products: Product[]; texts: TextLine[] } {
    if (!Array.isArray(raw)) throw new Error('Positionen fehlen.');
    if (raw.length > 1000) throw new Error('Zu viele Positionen.');
    const products: Product[] = [];
    const texts: TextLine[] = [];
    const ids = new Set<string>();
    raw.forEach((line: Input, sortOrder) => {
        if (!line || typeof line !== 'object') throw new Error('Position ungültig.');
        const id = line.id ? String(line.id) : null;
        if (id && ids.has(id)) throw new Error('Doppelte Positions-ID.');
        if (id) ids.add(id);
        const kind = String(line.kind || (line.articleId || line.materialId ? 'PRODUCT' : 'TEXT')).toUpperCase();
        if (kind !== 'PRODUCT' && kind !== 'TEXT') throw new Error('Positionsart ungültig.');
        const quantity = number(line.quantity ?? 1, 'Menge');
        if (quantity <= 0) throw new Error('Menge muss grösser als 0 sein.');
        const title = String(line.description || '').trim();
        const unitPrice = line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === '' ? null : number(line.unitPrice, 'Preis');
        const metadata: AddonLineMetadata = { description: title, quantity, unitPrice: unitPrice ?? 0, unit: String(line.unit || '').trim(),
            discounts: parseDiscountList(normalizeDiscountList(line.discounts, MAX_LINE_DISCOUNTS), MAX_LINE_DISCOUNTS), sortOrder };
        if (kind === 'PRODUCT') {
            const articleId = String(line.articleId || line.materialId || '').trim();
            if (!articleId) throw new Error('Artikel fehlt.');
            products.push({ id, articleId, quantity, unitPrice, description: String(line.longDescription || '').trim() || null, metadata });
        } else {
            if (!title) throw new Error('Bezeichnung fehlt.');
            metadata.unitPrice = unitPrice ?? number(line.amount ?? 0, 'Betrag') / quantity;
            const base = round2(quantity * metadata.unitPrice);
            if (!Number.isFinite(base)) throw new Error('Betrag ungültig.');
            texts.push({ id, description: title, longDescription: String(line.longDescription || '').trim() || null,
                amount: round2(remainingAfterDiscounts(base, metadata.discounts)), documentLine: JSON.stringify(metadata) });
        }
    });
    return { products, texts };
}

export function priceAddonProduct(line: Product, fallback: { salePrice?: number; name?: string }) {
    const price = line.unitPrice ?? number(fallback.salePrice ?? 0, 'Preis');
    const base = round2(line.quantity * price);
    if (!Number.isFinite(base)) throw new Error('Betrag ungültig.');
    const lineTotal = round2(remainingAfterDiscounts(base, line.metadata.discounts));
    return { ...line, lineTotal, unitPrice: lineTotal / line.quantity,
        documentLine: JSON.stringify({ ...line.metadata, unitPrice: price, description: line.metadata.description || fallback.name || '' }) };
}

export function readAddonLineMetadata(raw: string | null | undefined): AddonLineMetadata | null {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}
