"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTenderCustomer = void 0;
const nanoid_1 = require("nanoid");
/**
 * Ein Auftrag braucht einen Kunden im Kundenstamm (`SalesOrder.customerId`).
 * Eine Offerte darf ihren Kunden aber frei erfasst tragen
 * (`Tender.manualCustomer*`, ohne `customerId`). Wird eine solche Offerte zum
 * Auftrag, legt das hier den Kunden an — oder nimmt den gleichnamigen, der im
 * selben Mandanten schon existiert — und verknüpft die Offerte damit.
 *
 * Die `manualCustomer*`-Felder der Offerte bleiben unverändert: sie gewinnen
 * weiterhin über den Stammsatz, Offerte und PDF sehen also genau gleich aus.
 *
 * Gibt die Kunden-ID zurück, oder `null`, wenn die Offerte gar keinen Kunden
 * (auch keinen Namen) trägt.
 */
const ensureTenderCustomer = async (tx, tender, tenantId) => {
    if (tender.customerId)
        return tender.customerId;
    const name = String(tender.manualCustomerName || '').trim();
    if (!name)
        return null;
    const email = String(tender.manualCustomerEmail || '').trim() || null;
    let customer = await tx.customer.findFirst({
        where: { tenantId, companyName: name, isActive: true },
        select: { id: true },
        orderBy: { id: 'asc' },
    });
    if (!customer) {
        // Die frei erfasste Adresse ist Text, eine Zeile je Teil:
        // «Strasse» / «PLZ Ort» / «Land». Mehr wird nicht erraten.
        const lines = String(tender.manualCustomerAddress || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const street = lines[0] || null;
        const locality = lines[1] || '';
        const localityMatch = locality.match(/^(\d{3,6})\s+(.+)$/);
        const postalCode = localityMatch ? localityMatch[1] : null;
        const city = (localityMatch ? localityMatch[2] : locality) || null;
        const country = lines.length > 2 ? lines.slice(2).join(', ') : null;
        customer = await tx.customer.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
                tenantId,
                companyName: name.slice(0, 190),
                mainEmail: email,
                address: street,
                postalCode,
                city,
                country,
                customerSource: 'TENDER',
            },
            select: { id: true },
        });
    }
    await tx.tender.update({ where: { id: tender.id }, data: { customerId: customer.id } });
    tender.customerId = customer.id;
    return customer.id;
};
exports.ensureTenderCustomer = ensureTenderCustomer;
//# sourceMappingURL=tenderCustomer.js.map