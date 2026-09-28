import type { BomGoodsIn } from '../entities/ProductionBom';
import type { ReceivableLine } from '../services/productionBomStockReceipt';
import type { IBomGoodsInRepository } from './IProductionBomRepository';

/**
 * ── DEPO-BUCHUNG → WARENEINGANG DER BOM-BESTELLUNGEN (28.09.2026) ──────────
 * Welche bestätigten BOM-Bestellungen auf eine Karte warten, und was eine
 * Buchung im Protokoll «Gelen mallar» hinterliess (für «Geri al»).
 */
export interface IBomStockReceiptRepository {
    /** Die Positionen bestätigter BOM-Bestellungen (MAL KABULDE) zu dieser Karte — ohne Liefertermin. */
    receivableLines(tenantId: string, productId: string): Promise<Array<Omit<ReceivableLine, 'deliveryDate'>>>;
    /** Die Positionen EINER Bestellung zu dieser Karte, gleich welcher Stand (für «Geri al»). */
    orderLines(
        tenantId: string,
        purchaseOrderId: string,
        productId: string,
    ): Promise<Array<{ index: number; quantity: number; received: number }>>;
}

/** Das Protokoll «Gelen mallar», um die Rücknahme einer Depo-Buchung erweitert. */
export interface IBomGoodsInLedger extends IBomGoodsInRepository {
    forReceipt(tenantId: string, receiptId: string): Promise<BomGoodsIn[]>;
    /** Menge und Nummern neu setzen; eine Zeile, die auf 0 fällt, geht. */
    shrink(tenantId: string, changes: Array<{ id: string; quantity: number; serials: string[] }>): Promise<void>;
}
