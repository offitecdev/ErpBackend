import type { ProcurementEvent, ProcurementEventAction } from '../services/procurementFlow';

/**
 * Der Verlauf der Talepler («son işlem», «işlem geçmişi»). Jeder Eintrag ist
 * unveränderlich; gelesen wird je Talep oder nur der jüngste Eintrag vieler.
 */
export interface IProcurementJournal {
    record(
        tenantId: string,
        entry: {
            requestId: string;
            requestNumber: string;
            action: ProcurementEventAction;
            actorId: string | null;
            actorName: string | null;
            data?: Record<string, unknown>;
        },
    ): Promise<void>;
    /** Alle Einträge eines Talep, neueste zuerst. */
    forRequest(tenantId: string, requestId: string): Promise<ProcurementEvent[]>;
    /** Der jüngste Eintrag je Talep. */
    latest(tenantId: string, requestIds: string[]): Promise<Map<string, ProcurementEvent>>;
}
