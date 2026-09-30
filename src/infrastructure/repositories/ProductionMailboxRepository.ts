import { nanoid } from 'nanoid';

import prisma from '../database/prisma.client';
import { decryptSecret, encryptSecret } from '../services/outlook/mailCrypto';
import type { MailSettings } from '../services/SmtpMailService';

/**
 * ── DIE POSTFÄCHER DER PRODUKTION (30.09.2026, Vorgabe Samet) ──────────────
 *
 * «E postalar artık otomatik fiyat talebinde rfq@offitec.ch olarak
 *  gönderilecektir … üretim modülü ayarlarında o mailleri girelim, mail
 *  ayarlarını yapalım, şifresi şu bu.»
 *
 *   RFQ    Preisanfragen hinaus, Antworten der Lieferanten herein (Pflicht
 *          für die Automatik)
 *   ORDER  Bestellungen und ihre Revisionen — freiwillig; fehlt es, geht die
 *          Bestellung über das RFQ-Postfach
 *
 * Eine Zeile je Firma und Zweck (`uretim_posta_kutulari`); Passwörter wie beim
 * persönlichen Postfach verschlüsselt (mailCrypto). Die Spaltennamen sind die
 * von MailSetting — Versand (SmtpMailService) und Abruf (buildImapClient)
 * lesen sie mit demselben Code.
 */

export type MailboxPurpose = 'RFQ' | 'ORDER';
export const MAILBOX_PURPOSES: readonly MailboxPurpose[] = ['RFQ', 'ORDER'];

export interface ProductionMailboxRow {
    id: string;
    tenantId: string;
    purpose: MailboxPurpose;
    isActive: boolean;
    fromName: string | null;
    fromEmail: string;
    smtpHost: string | null;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string | null;
    /** verschlüsselt */
    smtpPassword: string | null;
    imapHost: string | null;
    imapPort: number;
    imapSecure: boolean;
    imapUser: string | null;
    /** verschlüsselt */
    imapPassword: string | null;
    imapFolder: string | null;
    sentFolder: string | null;
    saveToSent: boolean;
    imapUidValidity: bigint | null;
    imapLastUid: bigint | null;
    imapLastSyncAt: Date | null;
    imapLastError: string | null;
    imapLastSummary: string | null;
    updatedAt: Date;
}

export interface MailboxWrite {
    isActive: boolean;
    fromName: string | null;
    fromEmail: string;
    smtpHost: string | null;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string | null;
    imapHost: string | null;
    imapPort: number;
    imapSecure: boolean;
    imapUser: string | null;
    imapFolder: string | null;
    /** undefined/'' = behalten, null = löschen, Text = neu (Klartext, wird hier verschlüsselt). */
    smtpPassword?: string | null | undefined;
    imapPassword?: string | null | undefined;
}

const table = () => prisma.productionMailbox;

const purposeOf = (value: unknown): MailboxPurpose => (String(value).toUpperCase() === 'ORDER' ? 'ORDER' : 'RFQ');

const rowOf = (row: Record<string, unknown>): ProductionMailboxRow => ({
    ...(row as unknown as ProductionMailboxRow),
    purpose: purposeOf(row.purpose),
});

const secretFor = (next: string | null | undefined, current: string | null): string | null => {
    if (next === undefined || next === '') return current;
    if (next === null) return null;
    return encryptSecret(next);
};

export class PrismaProductionMailboxRepository {
    async list(tenantId: string): Promise<ProductionMailboxRow[]> {
        const rows = await table().findMany({ where: { tenantId } });
        return rows.map((row) => rowOf(row as unknown as Record<string, unknown>));
    }

    async get(tenantId: string, purpose: MailboxPurpose): Promise<ProductionMailboxRow | null> {
        const row = await table().findUnique({ where: { tenantId_purpose: { tenantId, purpose } } });
        return row ? rowOf(row as unknown as Record<string, unknown>) : null;
    }

    async byId(id: string): Promise<ProductionMailboxRow | null> {
        const row = await table().findUnique({ where: { id } });
        return row ? rowOf(row as unknown as Record<string, unknown>) : null;
    }

    async save(tenantId: string, purpose: MailboxPurpose, input: MailboxWrite, userId: string): Promise<ProductionMailboxRow> {
        const current = await this.get(tenantId, purpose);
        const data = {
            isActive: input.isActive,
            fromName: input.fromName,
            fromEmail: input.fromEmail,
            smtpHost: input.smtpHost,
            smtpPort: input.smtpPort,
            smtpSecure: input.smtpSecure,
            smtpUser: input.smtpUser,
            smtpPassword: secretFor(input.smtpPassword, current?.smtpPassword ?? null),
            imapHost: input.imapHost,
            imapPort: input.imapPort,
            imapSecure: input.imapSecure,
            imapUser: input.imapUser,
            imapPassword: secretFor(input.imapPassword, current?.imapPassword ?? null),
            imapFolder: input.imapFolder,
            updatedById: userId,
        };
        // Ein anderes Konto (Adresse/Server) liest von vorn — der alte Lesestand gehört dem alten.
        const accountChanged = current
            && (current.fromEmail.toLowerCase() !== input.fromEmail.toLowerCase() || (current.imapHost ?? '') !== (input.imapHost ?? ''));
        const row = current
            ? await table().update({
                where: { id: current.id },
                data: { ...data, ...(accountChanged ? { imapUidValidity: null, imapLastUid: null, imapLastError: null, imapLastSummary: null } : {}) },
            })
            : await table().create({ data: { id: nanoid(20), tenantId, purpose, ...data } });
        return rowOf(row as unknown as Record<string, unknown>);
    }

    async remove(tenantId: string, purpose: MailboxPurpose): Promise<boolean> {
        const result = await table().deleteMany({ where: { tenantId, purpose } });
        return result.count > 0;
    }

    /** Der Lesestand nach einem Abruf (auch der Fehler — die Seite zeigt ihn). */
    async setCursor(id: string, patch: {
        imapUidValidity?: bigint | null;
        imapLastUid?: bigint | null;
        imapLastSyncAt?: Date;
        imapLastError?: string | null;
        imapLastSummary?: string | null;
    }): Promise<void> {
        await table().update({ where: { id }, data: patch }).catch(() => undefined);
    }

    /** Die Postfächer, deren Antworten der Abruf liest (aktiv, mit IMAP-Server). */
    async forCapture(): Promise<ProductionMailboxRow[]> {
        const rows = await table().findMany({
            where: { isActive: true, NOT: { imapHost: null } },
            orderBy: { imapLastSyncAt: 'asc' },
            take: 50,
        });
        return rows.map((row) => rowOf(row as unknown as Record<string, unknown>));
    }
}

/** Die Einstellungen, mit denen SmtpMailService sendet — Passwörter entschlüsselt. */
export const mailSettingsOf = (row: ProductionMailboxRow): MailSettings => {
    let smtpPassword: string | null = null;
    let imapPassword: string | null = null;
    try { smtpPassword = decryptSecret(row.smtpPassword); } catch { smtpPassword = null; }
    try { imapPassword = decryptSecret(row.imapPassword); } catch { imapPassword = null; }
    return {
        fromName: row.fromName,
        fromEmail: row.fromEmail,
        replyTo: null,
        smtpHost: row.smtpHost,
        smtpPort: row.smtpPort,
        smtpSecure: row.smtpSecure,
        smtpUser: row.smtpUser || row.fromEmail,
        smtpPassword,
        imapHost: row.imapHost,
        imapPort: row.imapPort,
        imapSecure: row.imapSecure,
        imapUser: row.imapUser || row.smtpUser || row.fromEmail,
        imapPassword: imapPassword || smtpPassword,
        sentFolder: row.sentFolder,
        saveToSent: row.saveToSent,
    };
};
