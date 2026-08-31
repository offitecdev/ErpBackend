import prisma from "../../database/prisma.client";
import { getCompanyTreeTenantIds, getMailTenantId } from "../../../presentation/controllers/serviceTenantScope";

/**
 * Zuordnung einer Nachricht über die Grunddaten. Bekannt sind ZWEI Gruppen
 * (Vorgabe 18.08.2026 — "nicht nur von Kunden, auch von im System
 * registrierten Benutzern"):
 *
 *   KUNDEN     — `Customer.mainEmail` und `CustomerContact.email`; trifft keine
 *                Adresse, entscheidet die Firmendomain, aber nur wenn sie GENAU
 *                EINEM Kunden gehört und keine Freemail-Domain ist.
 *   MITARBEITENDE — `Employee.email` des ganzen Firmenbaums (Personal ist
 *                mandantenübergreifend, siehe getCompanyTreeTenantIds). Post von
 *                Kolleginnen und Kollegen ist damit ebenfalls "bekannt" und wird
 *                übernommen — ohne Kundenbezug, den setzt man bei Bedarf selbst.
 *
 * Kundentreffer haben VORRANG: schreibt eine Person, die zugleich Kunde und
 * Mitarbeiter ist, zählt der Kunde.
 *
 * Das Adressbuch wird pro Mandant kurz gecacht (der Abruf soll die Abfragen
 * nicht bei jedem Durchgang zahlen).
 */
export interface AddressBookHit {
    customerId: string | null;
    contactId: string | null;
    employeeId: string | null;
    source: "AUTO_ADDRESS" | "AUTO_DOMAIN" | "AUTO_EMPLOYEE";
}

interface AddressBook {
    byAddress: Map<string, { customerId: string; contactId: string | null }>;
    byDomain: Map<string, Set<string>>;
    /** Adressen registrierter Benutzer → Employee-Id. */
    byEmployee: Map<string, string>;
    /* ZU WELCHER FIRMA GEHÖRT DER TREFFER? Das Postfach hängt am Stamm des
       Baums, die Datensätze nicht: eine übernommene Kalendereinladung z. B.
       muss in der Firma landen, in der die erkannte Person arbeitet — am Stamm
       sähe sie niemand. Beide Zuordnungen fallen beim Laden ohnehin ab, sie
       kosten keine zusätzliche Abfrage. */
    employeeTenantById: Map<string, string>;
    customerTenantById: Map<string, string>;
    loadedAt: number;
}

const BOOK_TTL_MS = 5 * 60_000;
const books = new Map<string, AddressBook>();
const inflight = new Map<string, Promise<AddressBook>>();

const FREEMAIL_DOMAINS = new Set([
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.ch", "hotmail.de", "live.com", "live.ch",
    "msn.com", "yahoo.com", "yahoo.de", "yahoo.fr", "ymail.com", "icloud.com", "me.com", "mac.com", "gmx.ch",
    "gmx.net", "gmx.de", "gmx.at", "web.de", "bluewin.ch", "sunrise.ch", "hispeed.ch", "protonmail.com",
    "proton.me", "pm.me", "aol.com", "mail.com", "yandex.com", "t-online.de", "freenet.de", "swissonline.ch",
    "greenmail.ch", "vtxmail.ch", "quickline.ch", "bluemail.ch", "windowslive.com",
]);

export const normalizeAddress = (value: unknown): string => String(value || "").trim().toLowerCase();

export const domainOf = (address: string): string | null => {
    const at = address.lastIndexOf("@");
    if (at < 0) return null;
    const domain = address.slice(at + 1).trim().toLowerCase();
    return domain || null;
};

const hostOfWebsite = (website: string | null | undefined): string | null => {
    const raw = String(website || "").trim().toLowerCase();
    if (!raw) return null;
    try {
        const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
        return url.hostname.replace(/^www\./, "") || null;
    } catch {
        return null;
    }
};

const loadBook = async (tenantId: string): Promise<AddressBook> => {
    /* BAUMWEIT, NICHT JE FIRMA (13.09.2026). Das Postfach gehört dem Stamm des
       Firmenbaums (getMailTenantId) und trägt die Post ALLER Firmen darin. Ein
       Adressbuch, das nur die Kundschaft des Stamms kennt, hielte die Post der
       Untergesellschaften für fremd: sie käme ohne Kunden, ohne Ansprech-
       partner und ohne Etikett herein — genau die Zuordnung, für die es das
       Adressbuch gibt. */
    const recordTenantIds = await getCompanyTreeTenantIds(tenantId);
    const scope = { tenantId: { in: recordTenantIds } };
    const [customers, contacts, employees] = await Promise.all([
        prisma.customer.findMany({
            where: { ...scope, isActive: true },
            select: { id: true, tenantId: true, mainEmail: true, website: true },
        }),
        prisma.customerContact.findMany({
            where: { ...scope, email: { not: null } },
            select: { id: true, customerId: true, email: true },
        }),
        /* Hier bleibt es BAUMWEIT — anders als bei jeder Personenliste. Das
           Postfach hängt am Stamm des Baums (getMailTenantId); die Frage ist
           nicht "wen darf ich sehen", sondern "ist diese Absenderadresse eine
           von uns". Würde die Liste auf die eine Firma verengt, hielte das
           Postfach die Post der Schwesterfirmen für fremd und ordnete sie
           falsch zu. Ausgeschiedene und gesperrte Konten zählen nicht mehr
           als "bekannt". */
        recordTenantIds.length
            ? prisma.employee.findMany({
                where: { ...scope, isActive: true, deletedAt: null },
                select: { id: true, tenantId: true, email: true },
            })
            : Promise.resolve([] as Array<{ id: string; tenantId: string; email: string }>),
    ]);
    const byAddress = new Map<string, { customerId: string; contactId: string | null }>();
    const byDomain = new Map<string, Set<string>>();
    const addDomain = (domain: string | null, customerId: string) => {
        if (!domain || FREEMAIL_DOMAINS.has(domain)) return;
        let set = byDomain.get(domain);
        if (!set) { set = new Set(); byDomain.set(domain, set); }
        set.add(customerId);
    };
    const customerTenantById = new Map<string, string>();
    for (const customer of customers) {
        customerTenantById.set(customer.id, customer.tenantId);
        const address = normalizeAddress(customer.mainEmail);
        if (address.includes("@")) {
            byAddress.set(address, { customerId: customer.id, contactId: null });
            addDomain(domainOf(address), customer.id);
        }
        addDomain(hostOfWebsite(customer.website), customer.id);
    }
    for (const contact of contacts) {
        const address = normalizeAddress(contact.email);
        if (!address.includes("@")) continue;
        // Ansprechpartner-Treffer sind genauer als der Kunden-Haupttreffer und
        // dürfen ihn überschreiben (liefern zusätzlich contactId).
        byAddress.set(address, { customerId: contact.customerId, contactId: contact.id });
        addDomain(domainOf(address), contact.customerId);
    }
    const byEmployee = new Map<string, string>();
    const employeeTenantById = new Map<string, string>();
    for (const employee of employees) {
        const address = normalizeAddress(employee.email);
        if (!address.includes("@")) continue;
        byEmployee.set(address, employee.id);
        employeeTenantById.set(employee.id, employee.tenantId);
    }
    return { byAddress, byDomain, byEmployee, employeeTenantById, customerTenantById, loadedAt: Date.now() };
};

export const getAddressBook = async (selectedTenantId: string, { fresh = false } = {}): Promise<AddressBook> => {
    /* Ein Postfach, ein Adressbuch: der Schlüssel ist immer der Stamm des
       Firmenbaums. Sonst hielte jede Firma ihre eigene (inhaltsgleiche) Kopie,
       und `invalidateAddressBook` träfe nur eine davon. */
    const tenantId = await getMailTenantId(selectedTenantId);
    const cached = books.get(tenantId);
    if (cached && !fresh && Date.now() - cached.loadedAt < BOOK_TTL_MS) return cached;
    const running = inflight.get(tenantId);
    if (running) return running;
    const job = loadBook(tenantId)
        .then((book) => { books.set(tenantId, book); return book; })
        .finally(() => inflight.delete(tenantId));
    inflight.set(tenantId, job);
    return job;
};

export const invalidateAddressBook = (selectedTenantId: string) => {
    /* Der Aufrufer hat den Mail-Mandanten in der Hand — den sofort, damit der
       nächste Abruf im selben Zug schon neu lädt. Der aufgelöste Stamm kommt
       einen Zug später hinterher, falls doch jemand eine Untergesellschaft
       hereinreicht. */
    books.delete(selectedTenantId);
    void getMailTenantId(selectedTenantId)
        .then((tenantId) => { books.delete(tenantId); })
        .catch(() => undefined);
};

export const matchAddresses = (book: AddressBook, addresses: string[]): AddressBookHit | null => {
    const cleaned = addresses.map(normalizeAddress).filter((address) => address.includes("@"));
    // 1. Kundenadresse (genauester Treffer, bringt ggf. den Ansprechpartner mit)
    for (const address of cleaned) {
        const hit = book.byAddress.get(address);
        if (hit) return { customerId: hit.customerId, contactId: hit.contactId, employeeId: null, source: "AUTO_ADDRESS" };
    }
    // 2. Adresse einer registrierten Benutzerin / eines Benutzers
    for (const address of cleaned) {
        const employeeId = book.byEmployee.get(address);
        if (employeeId) return { customerId: null, contactId: null, employeeId, source: "AUTO_EMPLOYEE" };
    }
    // 3. Firmendomain — nur wenn sie eindeutig einem Kunden gehört
    for (const address of cleaned) {
        const domain = domainOf(address);
        if (!domain) continue;
        const owners = book.byDomain.get(domain);
        if (owners && owners.size === 1) {
            return { customerId: Array.from(owners)[0]!, contactId: null, employeeId: null, source: "AUTO_DOMAIN" };
        }
    }
    return null;
};
