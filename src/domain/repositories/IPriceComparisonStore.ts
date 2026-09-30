import type { ComparisonResult } from '../services/priceComparison';

/** Eine gespeicherte Fiyat karşılaştırması — unveränderlich, je Talep beliebig viele. */
export interface StoredPriceComparison {
    id: string;
    requestId: string;
    requestNumber: string;
    createdAt: Date;
    actorName: string | null;
    model: string;
    result: ComparisonResult;
}

export interface IPriceComparisonStore {
    save(
        tenantId: string,
        entry: {
            requestId: string;
            requestNumber: string;
            actorId: string | null;
            actorName: string | null;
            model: string;
            result: ComparisonResult;
        },
    ): Promise<StoredPriceComparison>;
    /** Die Vergleiche eines Talep, neueste zuerst. */
    forRequest(tenantId: string, requestId: string): Promise<StoredPriceComparison[]>;
    get(tenantId: string, id: string): Promise<StoredPriceComparison | null>;
}
