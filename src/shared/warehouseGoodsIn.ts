/**
 * ── «ÜRÜN EKLE» IST DER WARENEINGANG (28.09.2026, Vorgabe Samet) ────────────
 *
 * «Hiç sormadan, proje teslim tarihi en önce olan ürünün siparişine otomatik
 *  çeksin stoktan.» Was im Depo über «Ürün ekle» eingebucht wird (Scan, Menge,
 * Seriennummer), ist der Wareneingang der Bestellungen, die auf diese Karte
 * warten. Das Depo kennt diese Bestellungen nicht — es gibt die Buchung hier
 * weiter; wer zuhört (heute die BOM der Produktion), schreibt sie der
 * Bestellung gut und meldet zurück, wohin sie ging. Anders als
 * `warehouseStockEvents` wartet das Depo auf die Antwort: die Oberfläche zeigt
 * sie gleich an («10 adet → SP-2026-010 mal kabulü · Geri al»).
 *
 * Die Karte selbst (Menge von Hand, Excel-Aktarım) ist eine Berichtigung und
 * kommt hier nie an.
 */

/** Der Lieferant, den der gelesene Barcode nennt (Barcode je Lieferant an der Karte). */
export interface WarehouseGoodsInSupplier {
    supplierId: string | null;
    name: string;
}

export interface WarehouseGoodsInRequest {
    tenantId: string;
    userId: string;
    productId: string;
    /** Stück, die eben ins Depo kamen — bei Seriennummern deren Zahl. */
    quantity: number;
    /** Nur Karten mit Seriennummernpflicht: die eben gelesenen Nummern. */
    serials: string[];
    /** null = der Code nennt keinen Lieferanten: jede wartende Bestellung zählt. */
    supplier: WarehouseGoodsInSupplier | null;
}

/** Eine Bestellung, der die Buchung gutgeschrieben wurde. */
export interface WarehouseGoodsInCredit {
    /** Kennung der Buchung an dieser Bestellung — «Geri al» nennt sie. */
    receiptId: string;
    purchaseOrderId: string;
    referenceNumber: string;
    quantity: number;
    serials: string[];
    /** Die Positionen dieser Karte in der Bestellung: bestellt / jetzt da. */
    ordered: number;
    received: number;
    /** Die Bestellung ist damit ganz geliefert («Stoğa aktarıldı»). */
    completed: boolean;
    projectNumber: string | null;
    projectName: string | null;
    deviceName: string | null;
}

/** Wohin eine eben gelesene Seriennummer reserviert wurde. */
export interface WarehouseGoodsInReservation {
    serialNumber: string;
    projectNumber: string | null;
    projectName: string | null;
    deviceName: string | null;
}

export interface WarehouseGoodsInResult {
    credits: WarehouseGoodsInCredit[];
    /** Stück, auf die keine Bestellung wartete — freier Bestand. */
    free: number;
    reservations: WarehouseGoodsInReservation[];
}

/** «Geri al»: so viele Stück (oder diese Seriennummern) einer Buchung zurück. */
export interface WarehouseGoodsInUndoRequest {
    tenantId: string;
    userId: string;
    productId: string;
    entries: Array<{ receiptId: string; quantity: number; serials: string[] }>;
}

export interface WarehouseGoodsInHandler {
    /** Nach dem Einbuchen: gutschreiben und melden, wohin es ging (null = niemand zuständig). */
    book(request: WarehouseGoodsInRequest): Promise<WarehouseGoodsInResult | null>;
    /**
     * Prüft die Rücknahme, lässt dann das Depo buchen (`commitStock`) und nimmt
     * erst danach die Gutschrift zurück — scheitert die Prüfung oder das Depo,
     * ändert sich nichts.
     */
    undo(request: WarehouseGoodsInUndoRequest, commitStock: () => Promise<void>): Promise<void>;
}

/** Die Rücknahme passt nicht zu dem, was gebucht wurde (fremde oder verbrauchte Buchung). */
export const GOODS_IN_UNDO_INVALID = 'GOODS_IN_UNDO_INVALID';

export const goodsInUndoInvalid = (message: string): Error & { code: string } =>
    Object.assign(new Error(message), { code: GOODS_IN_UNDO_INVALID });

export const isGoodsInUndoInvalid = (error: unknown): boolean =>
    (error as { code?: unknown } | null)?.code === GOODS_IN_UNDO_INVALID;

/** Kennungen der Depo-Buchungen beginnen mit «D» (Wareneingang «R», Depo-Seriennummer «S»). */
export const DEPOT_RECEIPT_PREFIX = 'D';

let handler: WarehouseGoodsInHandler | null = null;

export const setWarehouseGoodsInHandler = (next: WarehouseGoodsInHandler): void => {
    handler = next;
};

export const warehouseGoodsInHandler = (): WarehouseGoodsInHandler | null => handler;
