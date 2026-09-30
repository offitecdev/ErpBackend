/**
 * ── DIE FREIGABE EINER REVISION DURCH DIE ADMINISTRATORROLLE (30.09.2026) ──
 *
 * «BOM revize edilmeden önce onay gerektirsin, admin'e onay düşsün, admin
 *  onaylayabilsin — sadece onaylarsa sipariş direkt otomatik revize gitsin.»
 * Wer die Revision bearbeitet, reicht sie ein; die Administratorrolle gibt sie
 * frei oder weist sie zurück. Festgehalten je Revision im Entwurf.
 */
export type BomRevisionApprovalAction = 'SUBMITTED' | 'REJECTED' | 'APPROVED';

export interface BomRevisionApprovalEntry {
    revisionId: string;
    action: BomRevisionApprovalAction;
    at: Date;
    actorId: string | null;
    actorName: string | null;
    note: string | null;
}

export interface IBomRevisionApprovals {
    record(tenantId: string, entry: {
        revisionId: string;
        bomId: string;
        bomNumber: string;
        revision: number;
        action: BomRevisionApprovalAction;
        actorId: string;
        actorName: string | null;
        note: string | null;
    }): Promise<void>;
    /** Der jüngste Eintrag je Revision (Kennung der Revision → Eintrag). */
    latest(tenantId: string, revisionIds: string[]): Promise<Map<string, BomRevisionApprovalEntry>>;
    /** Wer die Revision zuletzt eingereicht hat — an ihn geht die Antwort. */
    submitter(tenantId: string, revisionId: string): Promise<{ actorId: string | null; actorName: string | null } | null>;
}

/** Wer über eine Revision zu hören bekommt: die Administratorrolle bzw. wer sie eingereicht hat. */
export interface IBomRevisionNotifier {
    submitted(input: {
        tenantId: string;
        bomId: string;
        bomNumber: string;
        revision: number;
        link: string;
        actorId: string;
        actorName: string | null;
        reason: string | null;
    }): Promise<void>;
    decided(input: {
        tenantId: string;
        bomNumber: string;
        revision: number;
        link: string;
        recipientId: string | null;
        approved: boolean;
        actorId: string;
        actorName: string | null;
        note: string | null;
    }): Promise<void>;
}
