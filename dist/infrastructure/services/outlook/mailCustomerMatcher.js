"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchAddresses = exports.invalidateAddressBook = exports.getAddressBook = exports.domainOf = exports.normalizeAddress = void 0;
const prisma_client_1 = __importDefault(require("../../database/prisma.client"));
const serviceTenantScope_1 = require("../../../presentation/controllers/serviceTenantScope");
const BOOK_TTL_MS = 5 * 60_000;
const books = new Map();
const inflight = new Map();
const FREEMAIL_DOMAINS = new Set([
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.ch", "hotmail.de", "live.com", "live.ch",
    "msn.com", "yahoo.com", "yahoo.de", "yahoo.fr", "ymail.com", "icloud.com", "me.com", "mac.com", "gmx.ch",
    "gmx.net", "gmx.de", "gmx.at", "web.de", "bluewin.ch", "sunrise.ch", "hispeed.ch", "protonmail.com",
    "proton.me", "pm.me", "aol.com", "mail.com", "yandex.com", "t-online.de", "freenet.de", "swissonline.ch",
    "greenmail.ch", "vtxmail.ch", "quickline.ch", "bluemail.ch", "windowslive.com",
]);
const normalizeAddress = (value) => String(value || "").trim().toLowerCase();
exports.normalizeAddress = normalizeAddress;
const domainOf = (address) => {
    const at = address.lastIndexOf("@");
    if (at < 0)
        return null;
    const domain = address.slice(at + 1).trim().toLowerCase();
    return domain || null;
};
exports.domainOf = domainOf;
const hostOfWebsite = (website) => {
    const raw = String(website || "").trim().toLowerCase();
    if (!raw)
        return null;
    try {
        const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
        return url.hostname.replace(/^www\./, "") || null;
    }
    catch {
        return null;
    }
};
const loadBook = async (tenantId) => {
    const employeeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
    const [customers, contacts, employees] = await Promise.all([
        prisma_client_1.default.customer.findMany({
            where: { tenantId, isActive: true },
            select: { id: true, mainEmail: true, website: true },
        }),
        prisma_client_1.default.customerContact.findMany({
            where: { tenantId, email: { not: null } },
            select: { id: true, customerId: true, email: true },
        }),
        // Registrierte Benutzer des ganzen Firmenbaums; ausgeschiedene und
        // gesperrte Konten zählen nicht mehr als "bekannt".
        employeeTenantIds.length
            ? prisma_client_1.default.employee.findMany({
                where: { tenantId: { in: employeeTenantIds }, isActive: true, deletedAt: null },
                select: { id: true, email: true },
            })
            : Promise.resolve([]),
    ]);
    const byAddress = new Map();
    const byDomain = new Map();
    const addDomain = (domain, customerId) => {
        if (!domain || FREEMAIL_DOMAINS.has(domain))
            return;
        let set = byDomain.get(domain);
        if (!set) {
            set = new Set();
            byDomain.set(domain, set);
        }
        set.add(customerId);
    };
    for (const customer of customers) {
        const address = (0, exports.normalizeAddress)(customer.mainEmail);
        if (address.includes("@")) {
            byAddress.set(address, { customerId: customer.id, contactId: null });
            addDomain((0, exports.domainOf)(address), customer.id);
        }
        addDomain(hostOfWebsite(customer.website), customer.id);
    }
    for (const contact of contacts) {
        const address = (0, exports.normalizeAddress)(contact.email);
        if (!address.includes("@"))
            continue;
        // Ansprechpartner-Treffer sind genauer als der Kunden-Haupttreffer und
        // dürfen ihn überschreiben (liefern zusätzlich contactId).
        byAddress.set(address, { customerId: contact.customerId, contactId: contact.id });
        addDomain((0, exports.domainOf)(address), contact.customerId);
    }
    const byEmployee = new Map();
    for (const employee of employees) {
        const address = (0, exports.normalizeAddress)(employee.email);
        if (address.includes("@"))
            byEmployee.set(address, employee.id);
    }
    return { byAddress, byDomain, byEmployee, loadedAt: Date.now() };
};
const getAddressBook = async (tenantId, { fresh = false } = {}) => {
    const cached = books.get(tenantId);
    if (cached && !fresh && Date.now() - cached.loadedAt < BOOK_TTL_MS)
        return cached;
    const running = inflight.get(tenantId);
    if (running)
        return running;
    const job = loadBook(tenantId)
        .then((book) => { books.set(tenantId, book); return book; })
        .finally(() => inflight.delete(tenantId));
    inflight.set(tenantId, job);
    return job;
};
exports.getAddressBook = getAddressBook;
const invalidateAddressBook = (tenantId) => { books.delete(tenantId); };
exports.invalidateAddressBook = invalidateAddressBook;
const matchAddresses = (book, addresses) => {
    const cleaned = addresses.map(exports.normalizeAddress).filter((address) => address.includes("@"));
    // 1. Kundenadresse (genauester Treffer, bringt ggf. den Ansprechpartner mit)
    for (const address of cleaned) {
        const hit = book.byAddress.get(address);
        if (hit)
            return { customerId: hit.customerId, contactId: hit.contactId, employeeId: null, source: "AUTO_ADDRESS" };
    }
    // 2. Adresse einer registrierten Benutzerin / eines Benutzers
    for (const address of cleaned) {
        const employeeId = book.byEmployee.get(address);
        if (employeeId)
            return { customerId: null, contactId: null, employeeId, source: "AUTO_EMPLOYEE" };
    }
    // 3. Firmendomain — nur wenn sie eindeutig einem Kunden gehört
    for (const address of cleaned) {
        const domain = (0, exports.domainOf)(address);
        if (!domain)
            continue;
        const owners = book.byDomain.get(domain);
        if (owners && owners.size === 1) {
            return { customerId: Array.from(owners)[0], contactId: null, employeeId: null, source: "AUTO_DOMAIN" };
        }
    }
    return null;
};
exports.matchAddresses = matchAddresses;
//# sourceMappingURL=mailCustomerMatcher.js.map