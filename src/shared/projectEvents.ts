/**
 * ── «PROJE OLUŞTURULDU» OLAYI (24.09.2026) ──────────────────────────────────
 *
 * Projeyi oluşturan akışlar (teklif → sipariş → YENİ proje,
 * SalesOrderController; eski yol ProjectController) bu olayı yayınlar;
 * proje oluşunca iş yapması gereken modüller (bugün: «Siparişlerim» —
 * eksiklerin otomatik siparişi, bkz. projectProcurement.routes.ts) dinler.
 *
 * Böylece proje akışları sipariş modülünü içe aktarmaz (içe aktarma döngüsü
 * yok) ve bir dinleyicinin hatası projeyi oluşturan isteği bozmaz.
 */
export interface ProjectCreatedEvent {
    tenantId: string;
    projectId: string;
    /** Projeyi oluşturan çalışan — otomatik siparişlerin «oluşturan»ı. */
    userId: string;
}

type ProjectCreatedHandler = (event: ProjectCreatedEvent) => void;

const handlers: ProjectCreatedHandler[] = [];

export const onProjectCreated = (handler: ProjectCreatedHandler): void => {
    handlers.push(handler);
};

export const emitProjectCreated = (event: ProjectCreatedEvent): void => {
    for (const handler of handlers) {
        try {
            handler(event);
        } catch (error: any) {
            console.warn('[projectEvents] handler failed', event.projectId, error?.message);
        }
    }
};
