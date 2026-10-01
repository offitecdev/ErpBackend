"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaSupplierEmailBook = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const supplierEmails_1 = require("../../domain/services/supplierEmails");
/**
 * Die Lieferantenliste (Supplier) als Adressbuch der Produktion (30.09.2026).
 * Einzige Stelle, an der Depo und Einkauf der Produktion in die Liste
 * schreiben — und nur die E-Mail. Der Name wird nicht angelegt: wer nur beim
 * Namen bekannt ist, kommt mit der ersten Anfrage in die Liste (der Schreiber
 * der Bestellungen legt ihn an), danach trägt ihn die Adresse.
 */
class PrismaSupplierEmailBook {
    async find(tenantId, supplier) {
        if (supplier.supplierId) {
            const byId = await prisma_client_1.default.supplier.findFirst({ where: { id: supplier.supplierId, tenantId }, select: { id: true, email: true } });
            if (byId)
                return byId;
        }
        const name = String(supplier.name ?? '').trim();
        if (!name)
            return null;
        // Die Sortierung der Datenbank vergleicht ohne Gross/Klein.
        return prisma_client_1.default.supplier.findFirst({ where: { tenantId, companyName: name }, select: { id: true, email: true } });
    }
    async remember(tenantId, entries) {
        let changed = 0;
        const seen = new Set();
        for (const entry of entries) {
            const email = (0, supplierEmails_1.cleanSupplierEmail)(entry.email);
            if (!email)
                continue;
            const key = `${entry.supplierId ?? ''}|${String(entry.name ?? '').trim().toLocaleLowerCase('tr-TR')}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const supplier = await this.find(tenantId, entry);
            if (!supplier || String(supplier.email ?? '').trim().toLowerCase() === email.toLowerCase())
                continue;
            await prisma_client_1.default.supplier.update({ where: { id: supplier.id }, data: { email } });
            changed += 1;
        }
        return changed;
    }
    async emailOf(tenantId, supplier) {
        const row = await this.find(tenantId, supplier);
        return (0, supplierEmails_1.cleanSupplierEmail)(row?.email);
    }
}
exports.PrismaSupplierEmailBook = PrismaSupplierEmailBook;
//# sourceMappingURL=SupplierEmailBook.js.map