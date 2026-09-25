import prisma from '../infrastructure/database/prisma.client';
import { invoiceError } from '../application/use-cases/billing/invoiceErrors';
import { nextDocumentNumber, parseDocumentNumber, peekDocumentNumber, raiseDocumentCounter } from './documentNumber';

export interface DirectInvoiceNumberRequest {
    requested?: string | null;
    proforma: boolean;
    year: number;
}

export const validateDirectInvoiceNumber = (raw: unknown): string | null => {
    if (raw == null || raw === '') return null;
    if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.trim())) {
        throw invoiceError('NUMBER_INVALID', 'Die Belegnummer darf nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich enthalten (max. 64).');
    }
    return raw.trim();
};

const nextProforma = async (db: any, tenantId: string, year: number): Promise<string> => {
    const prefix = `PI-${year}-`;
    const rows: Array<{ invoiceNumber: string }> = await db.invoice.findMany({
        where: { tenantId, invoiceNumber: { startsWith: prefix } }, select: { invoiceNumber: true },
    });
    const max = rows.reduce((highest, row) => {
        const tail = row.invoiceNumber.slice(prefix.length);
        return /^\d+$/.test(tail) ? Math.max(highest, Number(tail)) : highest;
    }, 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
};

export const peekDirectInvoiceNumber = (tenantId: string, proforma: boolean, year: number): Promise<string> =>
    proforma ? nextProforma(prisma, tenantId, year) : peekDocumentNumber(tenantId, 'INVOICE');

/** Allocate/check the code in the SAME transaction as the invoice write. */
export const assignDirectInvoiceNumber = async (tx: any, tenantId: string, request: DirectInvoiceNumberRequest, excludeId?: string): Promise<string> => {
    // Serializes manual and PI numbers for this company, including the first PI.
    await tx.$queryRaw`SELECT id FROM Tenant WHERE id = ${tenantId} FOR UPDATE`;
    const requested = validateDirectInvoiceNumber(request.requested);
    const number = requested || (request.proforma
        ? await nextProforma(tx, tenantId, request.year)
        : await nextDocumentNumber(tenantId, 'INVOICE', tx));
    // Coordinate custom RE codes with the standard invoice sequence as well.
    const standard = parseDocumentNumber(number, 'INVOICE');
    if (requested && standard) await raiseDocumentCounter(tenantId, 'INVOICE', standard.seq, tx);
    const conflict = await tx.invoice.findFirst({
        where: { tenantId, invoiceNumber: number, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true },
    });
    if (conflict) throw invoiceError('NUMBER_EXISTS', 'Diese Belegnummer ist bereits vergeben.', { status: 409 });
    return number;
};
