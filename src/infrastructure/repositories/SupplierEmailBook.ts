import prisma from '../database/prisma.client';
import type { ISupplierEmailBook, SupplierEmailEntry } from '../../domain/repositories/ISupplierEmailBook';
import { cleanSupplierEmail } from '../../domain/services/supplierEmails';

/**
 * Die Lieferantenliste (Supplier) als Adressbuch der Produktion (30.09.2026).
 * Einzige Stelle, an der Depo und Einkauf der Produktion in die Liste
 * schreiben — und nur die E-Mail. Der Name wird nicht angelegt: wer nur beim
 * Namen bekannt ist, kommt mit der ersten Anfrage in die Liste (der Schreiber
 * der Bestellungen legt ihn an), danach trägt ihn die Adresse.
 */
export class PrismaSupplierEmailBook implements ISupplierEmailBook {
    private async find(tenantId: string, supplier: { supplierId: string | null; name: string | null }) {
        if (supplier.supplierId) {
            const byId = await prisma.supplier.findFirst({ where: { id: supplier.supplierId, tenantId }, select: { id: true, email: true } });
            if (byId) return byId;
        }
        const name = String(supplier.name ?? '').trim();
        if (!name) return null;
        // Die Sortierung der Datenbank vergleicht ohne Gross/Klein.
        return prisma.supplier.findFirst({ where: { tenantId, companyName: name }, select: { id: true, email: true } });
    }

    async remember(tenantId: string, entries: SupplierEmailEntry[]): Promise<number> {
        let changed = 0;
        const seen = new Set<string>();
        for (const entry of entries) {
            const email = cleanSupplierEmail(entry.email);
            if (!email) continue;
            const key = `${entry.supplierId ?? ''}|${String(entry.name ?? '').trim().toLocaleLowerCase('tr-TR')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const supplier = await this.find(tenantId, entry);
            if (!supplier || String(supplier.email ?? '').trim().toLowerCase() === email.toLowerCase()) continue;
            await prisma.supplier.update({ where: { id: supplier.id }, data: { email } });
            changed += 1;
        }
        return changed;
    }

    async emailOf(tenantId: string, supplier: { supplierId: string | null; name: string | null }): Promise<string | null> {
        const row = await this.find(tenantId, supplier);
        return cleanSupplierEmail(row?.email);
    }
}
