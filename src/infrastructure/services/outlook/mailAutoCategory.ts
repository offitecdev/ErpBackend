import { Prisma } from "@prisma/client";
import prisma from "../../database/prisma.client";
import { getMailTenantId } from "../../../presentation/controllers/serviceTenantScope";

/**
 * DAS ETIKETT KOMMT VON SELBST (30.08.2026).
 *
 * `mailCustomerMatcher` sagt, WEM eine Nachricht gehört — dem Kunden hinter
 * der Adresse oder der registrierten Person, die geschrieben hat. Bisher blieb
 * es dabei: die Kategorienleiste musste jede Mail von Hand eingesammelt
 * bekommen. Hier wird der Schluss gezogen, der ohnehin jeder von Hand zog:
 *
 *   Steht der Kunde (bzw. die Person) SCHON als Kategorie in der Leiste,
 *   trägt die Nachricht dieses Etikett beim Speichern gleich mit.
 *
 * ANGELEGT WIRD NICHTS. Die Leiste ist die persönliche Ordnung des Postfachs
 * (von Hand gezogene Reihenfolge, zehn Farben reihum) — ein Etikett je Kunde,
 * der je geschrieben hat, machte aus ihr eine zweite Kundenliste. Wer einen
 * Kunden in der Leiste haben will, legt ihn an; ab dann sammelt sich seine
 * Post von selbst, rückwirkend UND künftig (`labelExistingMessages`).
 *
 * Ein Etikett von Hand wird NIE überschrieben: der Abruf setzt `categoryId`
 * nur dort, wo noch keines steht.
 *
 * Der Index liegt kurz im Speicher (wie das Adressbuch) — der Abruf soll die
 * Abfrage nicht je Nachricht zahlen. Anlegen und Löschen einer Kategorie
 * verwerfen ihn sofort, damit die neue Zeile schon den laufenden Abruf trifft.
 */
export interface CategoryIndex {
    /** customerId → categoryId (Kategorie-Art CUSTOMER) */
    byCustomer: Map<string, string>;
    /** employeeId → categoryId (Kategorie-Art STAFF) */
    byStaff: Map<string, string>;
    loadedAt: number;
}

const INDEX_TTL_MS = 5 * 60_000;
const indexes = new Map<string, CategoryIndex>();
const inflight = new Map<string, Promise<CategoryIndex>>();

const loadIndex = async (tenantId: string): Promise<CategoryIndex> => {
    const rows = await prisma.mailCategory.findMany({
        where: { tenantId, kind: { in: ["CUSTOMER", "STAFF"] }, NOT: { entityId: null } },
        select: { id: true, kind: true, entityId: true },
    });
    const byCustomer = new Map<string, string>();
    const byStaff = new Map<string, string>();
    for (const row of rows) {
        if (!row.entityId) continue;
        if (row.kind === "CUSTOMER") byCustomer.set(row.entityId, row.id);
        else byStaff.set(row.entityId, row.id);
    }
    return { byCustomer, byStaff, loadedAt: Date.now() };
};

export const getCategoryIndex = async (selectedTenantId: string, { fresh = false } = {}): Promise<CategoryIndex> => {
    /* Die Leiste gehört dem Postfach, das Postfach dem Stamm des Firmenbaums:
       ein Index je Baum, nicht je Firma. */
    const tenantId = await getMailTenantId(selectedTenantId);
    const cached = indexes.get(tenantId);
    if (cached && !fresh && Date.now() - cached.loadedAt < INDEX_TTL_MS) return cached;
    const running = inflight.get(tenantId);
    if (running) return running;
    const job = loadIndex(tenantId)
        .then((index) => { indexes.set(tenantId, index); return index; })
        .finally(() => inflight.delete(tenantId));
    inflight.set(tenantId, job);
    return job;
};

export const invalidateCategoryIndex = (selectedTenantId: string) => {
    // Sofort für den übergebenen Schlüssel (die Aufrufer halten den
    // Mail-Mandanten), der aufgelöste Stamm einen Zug später hinterher.
    indexes.delete(selectedTenantId);
    void getMailTenantId(selectedTenantId)
        .then((tenantId) => { indexes.delete(tenantId); })
        .catch(() => undefined);
};

/**
 * Das Etikett zur erkannten Gegenstelle — oder null, wenn sie keine Kategorie
 * in der Leiste hat. Der KUNDE hat Vorrang vor der Person (dieselbe Reihenfolge
 * wie beim Adresstreffer: wer Kunde UND Mitarbeiter ist, zählt als Kunde).
 */
export const autoCategoryId = (
    index: CategoryIndex,
    party: { customerId?: string | null | undefined; employeeId?: string | null | undefined },
): string | null => {
    if (party.customerId) {
        const hit = index.byCustomer.get(party.customerId);
        if (hit) return hit;
    }
    if (party.employeeId) {
        const hit = index.byStaff.get(party.employeeId);
        if (hit) return hit;
    }
    return null;
};

/**
 * RÜCKWIRKEND: die schon gespeicherte Post der eben angelegten Kategorie
 * einsammeln — sonst steht ein frisch angelegter Kunde mit «0» in der Leiste,
 * obwohl seine Korrespondenz seit Monaten im Postfach liegt.
 *
 * Nur Nachrichten OHNE Etikett; eine von Hand gesetzte Zuordnung bleibt, wo
 * sie ist. Beim Personal zählt nur der ADRESSTREFFER (AUTO_EMPLOYEE, die
 * Person hat selbst geschrieben) — bei einer ERP-Sendung steht in
 * `employeeId` die Absenderin aus dem Haus, und deren Kundenpost gehört nicht
 * in ihr eigenes Fach.
 *
 * Der Papierkorb wird mitgenommen: die Zeile bekommt ihr Etikett, gezeigt
 * wird sie deswegen nicht (Gelöschtes liegt in keiner Kategorie).
 */
export const labelExistingMessages = async (
    tenantId: string,
    kind: string,
    entityId: string,
    categoryId: string,
): Promise<number> => {
    let where: Prisma.MailMessageWhereInput;
    if (kind === "CUSTOMER") where = { tenantId, categoryId: null, customerId: entityId };
    else if (kind === "STAFF") where = { tenantId, categoryId: null, employeeId: entityId, matchSource: "AUTO_EMPLOYEE" };
    else return 0;
    const result = await prisma.mailMessage.updateMany({ where, data: { categoryId } });
    return result.count;
};
