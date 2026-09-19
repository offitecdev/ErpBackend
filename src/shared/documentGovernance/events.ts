import type { Request } from 'express';
import { nanoid } from 'nanoid';

/**
 * ── BELEGVERLAUF SCHREIBEN (16.09.2026, Schritt 4 / D1) ──────────────────────
 *
 * EIN Aufruf je Handlung, IN der Transaktion der Handlung: gelingt die
 * Handlung, steht der Eintrag; scheitert sie, steht auch er nicht. Es gibt
 * keinen Weg, einen Eintrag zu ändern oder zu löschen — nicht im Code und
 * nicht in der Oberfläche.
 *
 * Belegnummer und Name der handelnden Person werden als TEXT festgehalten:
 * der Eintrag muss lesbar bleiben, auch wenn der Beleg gelöscht oder die
 * Person umbenannt wurde.
 */

type Db = any;

export type DocumentEntityType = 'TENDER' | 'SALES_ORDER' | 'ADDON_ORDER' | 'PROJECT' | 'INVOICE';

export type DocumentEventAction =
    | 'DELETED'
    | 'CANCELLED'
    | 'UNCANCELLED'
    | 'REVERTED_TO_DRAFT'
    | 'TEXT_CORRECTED'
    | 'STATUS_CHANGED'
    // Buchhaltung (Schritt 5): Entwurf angelegt, ausgestellt, verworfen.
    | 'DRAFT_CREATED'
    | 'ISSUED'
    | 'DRAFT_DISCARDED'
    // Schritt 6: Storno-Rechnung / Gutschrift ausgestellt, ganzer Vorgang storniert.
    | 'CREDIT_ISSUED'
    | 'FULL_CANCELLED'
    // Schritt 7: Zahlungseingänge.
    | 'PAYMENT_RECORDED'
    | 'PAYMENT_REMOVED';

export interface DocumentEventInput {
    tenantId: string;
    entityType: DocumentEntityType;
    entityId: string;
    documentNumber?: string | null;
    action: DocumentEventAction;
    actorId: string;
    reason?: string | null;
    /** Gesetzt = die Systemverwaltung hat diese Sperren bewusst überschritten. */
    override?: { blockers: string[] } | null;
    /** Knapper Stand zum Zeitpunkt der Handlung — nur, was man später lesen will. */
    snapshot?: Record<string, unknown> | null;
    /** Der Eintrag erscheint auch im Verlauf dieser Belege. */
    links?: { projectId?: string | null; tenderId?: string | null; salesOrderId?: string | null };
    ipAddress?: string | null;
}

const clip = (value: string | null | undefined, max: number) =>
    value == null ? null : String(value).slice(0, max);

export const recordDocumentEvent = async (db: Db, input: DocumentEventInput): Promise<void> => {
    const actor = await db.employee.findUnique({
        where: { id: input.actorId },
        select: { firstName: true, lastName: true },
    }).catch(() => null);
    const actorName = actor ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || null : null;

    await db.documentEvent.create({
        data: {
            id: nanoid(14),
            tenantId: input.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            documentNumber: clip(input.documentNumber, 191),
            action: input.action,
            reason: clip(input.reason?.trim() || null, 2000),
            override: Boolean(input.override),
            overriddenBlockers: input.override ? input.override.blockers : undefined,
            snapshot: input.snapshot ?? undefined,
            projectId: input.links?.projectId ?? null,
            tenderId: input.links?.tenderId ?? null,
            salesOrderId: input.links?.salesOrderId ?? null,
            actorId: input.actorId,
            actorName: clip(actorName, 191),
            ipAddress: clip(input.ipAddress ?? null, 64),
        },
    });
};

/** Die Adresse der anfragenden Person (hinter dem Proxy die erste aus X-Forwarded-For). */
export const requestIp = (req: Request): string | null => {
    const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    return forwarded || req.ip || req.socket?.remoteAddress || null;
};
