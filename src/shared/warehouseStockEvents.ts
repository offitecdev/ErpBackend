/**
 * ── «DEPODA BESTAND GEÄNDERT» (27.09.2026) ──────────────────────────────────
 *
 * Das Depo meldet, wenn an einer Karte Bestand oder Seriennummern dazukamen
 * (neue Karte, Scan «+», neue Nummer, Excel-Aktarım). Wer daran hängt — heute
 * die BOM der Produktion: «geldiği anda, depoya geldi, eklendi — bu eklenenler
 * rezerve olmalı» —, hört hier zu. So muss das Depo die BOM nicht kennen (kein
 * Ring beim Laden), und ein Fehler des Zuhörers bricht das Depo nie ab.
 */
export interface WarehouseStockChangedEvent {
    tenantId: string;
    productIds: string[];
}

type Handler = (event: WarehouseStockChangedEvent) => void;

const handlers: Handler[] = [];

export const onWarehouseStockChanged = (handler: Handler): void => {
    handlers.push(handler);
};

export const emitWarehouseStockChanged = (event: WarehouseStockChangedEvent): void => {
    const productIds = [...new Set(event.productIds.filter(Boolean))];
    if (!productIds.length) return;
    for (const handler of handlers) {
        try {
            handler({ tenantId: event.tenantId, productIds });
        } catch (error) {
            console.warn('[warehouseStockEvents] handler failed', (error as Error)?.message);
        }
    }
};
