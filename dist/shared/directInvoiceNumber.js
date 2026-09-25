"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignDirectInvoiceNumber = exports.peekDirectInvoiceNumber = exports.validateDirectInvoiceNumber = void 0;
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const invoiceErrors_1 = require("../application/use-cases/billing/invoiceErrors");
const documentNumber_1 = require("./documentNumber");
const validateDirectInvoiceNumber = (raw) => {
    if (raw == null || raw === '')
        return null;
    if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.trim())) {
        throw (0, invoiceErrors_1.invoiceError)('NUMBER_INVALID', 'Die Belegnummer darf nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich enthalten (max. 64).');
    }
    return raw.trim();
};
exports.validateDirectInvoiceNumber = validateDirectInvoiceNumber;
const nextProforma = async (db, tenantId, year) => {
    const prefix = `PI-${year}-`;
    const rows = await db.invoice.findMany({
        where: { tenantId, invoiceNumber: { startsWith: prefix } }, select: { invoiceNumber: true },
    });
    const max = rows.reduce((highest, row) => {
        const tail = row.invoiceNumber.slice(prefix.length);
        return /^\d+$/.test(tail) ? Math.max(highest, Number(tail)) : highest;
    }, 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
};
const peekDirectInvoiceNumber = (tenantId, proforma, year) => proforma ? nextProforma(prisma_client_1.default, tenantId, year) : (0, documentNumber_1.peekDocumentNumber)(tenantId, 'INVOICE');
exports.peekDirectInvoiceNumber = peekDirectInvoiceNumber;
/** Allocate/check the code in the SAME transaction as the invoice write. */
const assignDirectInvoiceNumber = async (tx, tenantId, request, excludeId) => {
    // Serializes manual and PI numbers for this company, including the first PI.
    await tx.$queryRaw `SELECT id FROM Tenant WHERE id = ${tenantId} FOR UPDATE`;
    const requested = (0, exports.validateDirectInvoiceNumber)(request.requested);
    const number = requested || (request.proforma
        ? await nextProforma(tx, tenantId, request.year)
        : await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'INVOICE', tx));
    // Coordinate custom RE codes with the standard invoice sequence as well.
    const standard = (0, documentNumber_1.parseDocumentNumber)(number, 'INVOICE');
    if (requested && standard)
        await (0, documentNumber_1.raiseDocumentCounter)(tenantId, 'INVOICE', standard.seq, tx);
    const conflict = await tx.invoice.findFirst({
        where: { tenantId, invoiceNumber: number, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true },
    });
    if (conflict)
        throw (0, invoiceErrors_1.invoiceError)('NUMBER_EXISTS', 'Diese Belegnummer ist bereits vergeben.', { status: 409 });
    return number;
};
exports.assignDirectInvoiceNumber = assignDirectInvoiceNumber;
//# sourceMappingURL=directInvoiceNumber.js.map