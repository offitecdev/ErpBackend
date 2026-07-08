import { nanoid } from "nanoid";
import prisma from "../../../infrastructure/database/prisma.client";

type CsvRow = string[];

interface HeaderInfo {
    raw: string;
    normalized: string;
    canonical?: string | undefined;
}

interface ImportGroup {
    orderReference: string;
    rows: CsvRow[];
}

const CANONICAL_HEADERS: Record<string, string[]> = {
    orderReference: ["Auftragsreferenz"],
    createdAt: ["Erstellungsdatum"],
    total: ["Gesamt"],
    commissionNumber: ["Kommission-Nr."],
    customerName: ["Kunde"],
    status: ["Status"],
    company: ["Unternehmen"],
    salesperson: ["Vertriebsmitarbeiter"],
    billingAddress: ["Rechnungsadresse"],
    shippingAddress: ["Lieferadresse"],
    internalDeliveryDate: ["Lieferdatum (Intern)"],
    validUntil: ["Gültigkeit", "GÃ¼ltigkeit"],
    orderDate: ["Auftragsdatum"],
    recurringPlan: ["Wiederkehrender Plan"],
    priceList: ["Preisliste"],
    paymentTerms: ["Zahlungsbedingungen"],
    orderLines: ["Auftragspositionen"],
    addProducts: ["Produkte hinzufügen", "Produkte hinzufÃ¼gen"],
    product: ["Auftragspositionen/Produkt"],
    description: ["Auftragspositionen/Beschreibung"],
    quantity: ["Auftragspositionen/Menge"],
    unit: ["Auftragspositionen/Maßeinheit", "Auftragspositionen/MaÃŸeinheit"],
    unitPrice: ["Auftragspositionen/Einzelpreis"],
    tax: ["Auftragspositionen/Steuern"],
    discount: ["Auftragspositionen/Rabatt (%)"],
    netAmount: ["Nettobetrag"],
    taxAmount: ["Steuern"],
    recurringTotal: ["Insgesamt wiederkehrend"],
    margin: ["Marge"],
    text: ["Text"],
    imageUrl: ["Auftragspositionen/Produkt/Bild"],
    salesTeam: ["Verkaufsteam"],
    onlineSignature: ["Online-Signatur"],
    onlinePayment: ["Online-Zahlung"],
    customerReference: ["Kundenreferenz"],
    tags: ["Stichwörter", "StichwÃ¶rter"],
    shippingTerms: ["Versandbedingungen"],
    shippingWeight: ["Versandgewicht"],
    fiscalPosition: ["Steuerposition"],
    messageAuthor: ["Mitteilungen/Autor"],
    messages: ["Mitteilungen"],
    messageContent: ["Mitteilungen/Inhalte"],
    messageDate: ["Mitteilungen/Datum"],
    messageAttachments: ["Mitteilungen/Dateianhänge", "Mitteilungen/DateianhÃ¤nge"],
    messageAttachmentDocument: ["Mitteilungen/Dateianhänge/Dokument", "Mitteilungen/DateianhÃ¤nge/Dokument"],
};

const GERMAN_LABELS: Record<string, string> = {
    orderLines: "Auftragspositionen",
    tax: "Steuern",
    netAmount: "Nettobetrag",
    taxAmount: "Steuern",
    margin: "Marge",
    messageAuthor: "Mitteilungen/Autor",
    messages: "Mitteilungen",
    messageContent: "Mitteilungen/Inhalte",
    messageDate: "Mitteilungen/Datum",
    messageAttachments: "Mitteilungen/Dateianhänge",
    messageAttachmentDocument: "Mitteilungen/Dateianhänge/Dokument",
};

const ROW_DETAIL_FIELDS = [
    "orderLines",
    "tax",
    "netAmount",
    "taxAmount",
    "margin",
    "messageAuthor",
    "messages",
    "messageContent",
    "messageDate",
    "messageAttachments",
    "messageAttachmentDocument",
];

const TENDER_META_FIELDS = new Set([
    "createdAt",
    "orderDate",
    "commissionNumber",
    "status",
    "company",
    "salesperson",
    "billingAddress",
    "shippingAddress",
    "internalDeliveryDate",
    "validUntil",
    "priceList",
    "paymentTerms",
    "customerReference",
    "tags",
    "shippingTerms",
    "shippingWeight",
    "fiscalPosition",
    "total",
    "recurringTotal",
    "text",
    "salesTeam",
    "onlineSignature",
    "onlinePayment",
]);

const DIRECT_POSITION_FIELDS = new Set([
    "product",
    "description",
    "quantity",
    "unit",
    "unitPrice",
    "discount",
    "imageUrl",
]);

const normalizeHeader = (value: string) =>
    String(value || "")
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("de-DE")
        .replace(/\s+/g, " ");

const headerLookup = new Map<string, string>(
    Object.entries(CANONICAL_HEADERS).flatMap(([canonical, labels]) =>
        labels.map((label) => [normalizeHeader(label), canonical] as [string, string])
    )
);

const parseCsv = (text: string): CsvRow[] => {
    const rows: CsvRow[] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    const source = String(text || "").replace(/^\uFEFF/, "");

    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];

        if (quoted) {
            if (ch === '"' && next === '"') {
                cell += '"';
                i += 1;
            } else if (ch === '"') {
                quoted = false;
            } else {
                cell += ch;
            }
            continue;
        }

        if (ch === '"') {
            quoted = true;
        } else if (ch === ",") {
            row.push(cell);
            cell = "";
        } else if (ch === "\n") {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else if (ch !== "\r") {
            cell += ch;
        }
    }

    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }

    return rows.filter((r) => r.some((c) => String(c || "").trim()));
};

const valueAt = (headers: HeaderInfo[], row: CsvRow, canonical: string): string => {
    for (let i = 0; i < headers.length; i += 1) {
        if (headers[i]?.canonical !== canonical) continue;
        const value = String(row[i] || "").trim();
        if (value) return value;
    }
    return "";
};

const firstValue = (headers: HeaderInfo[], rows: CsvRow[], canonical: string): string => {
    for (const row of rows) {
        const value = valueAt(headers, row, canonical);
        if (value) return value;
    }
    return "";
};

const parseNumber = (value: string): number => {
    const raw = String(value || "")
        .replace(/\s/g, "")
        .replace(/CHF|%/gi, "")
        .replace(/[^\d,.\-]/g, "");
    if (!raw) return 0;
    const lastComma = raw.lastIndexOf(",");
    const lastDot = raw.lastIndexOf(".");
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const normalized = raw
        .replace(decimalSeparator === "," ? /\./g : /,/g, "")
        .replace(decimalSeparator, ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
};

const parseDate = (value: string): Date | null => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return null;
    const isoLike = trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed;
    const parsed = new Date(isoLike);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const compactDetails = (details: Array<[string, string]>) =>
    details
        .filter(([, value]) => String(value || "").trim())
        .map(([label, value]) => `${label}: ${String(value).trim()}`)
        .join("\n");

const labelForCanonical = (headers: HeaderInfo[], canonical: string) =>
    headers.find((header) => header.canonical === canonical)?.raw || GERMAN_LABELS[canonical] || canonical;

const makeDetails = (headers: HeaderInfo[], row: CsvRow, fields: string[]) =>
    compactDetails(fields.map((field) => [labelForCanonical(headers, field), valueAt(headers, row, field)]));

const makeUnknownDetails = (headers: HeaderInfo[], row: CsvRow) =>
    compactDetails(headers
        .map((header, index) => [header.raw || `Column ${index + 1}`, String(row[index] || "").trim()] as [string, string])
        .filter((_, index) => {
            const canonical = headers[index]?.canonical;
            return !canonical || (!DIRECT_POSITION_FIELDS.has(canonical) && !TENDER_META_FIELDS.has(canonical) && !ROW_DETAIL_FIELDS.includes(canonical));
        }));

const firstDescriptionLine = (description: string) =>
    String(description || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || "";

const safeArticleCode = (product: string, description: string, index: number) => {
    const base = product || firstDescriptionLine(description) || `IMPORTED-${index + 1}`;
    return base.replace(/\s+/g, "-").replace(/[^\w\-./]/g, "").slice(0, 80) || `IMPORTED-${index + 1}`;
};

const parseBoolean = (value: string): boolean | null => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return null;
    if (["true", "1", "yes", "ja", "evet"].includes(normalized)) return true;
    if (["false", "0", "no", "nein", "hayir", "hayır"].includes(normalized)) return false;
    return null;
};

const normalizeTenderStatusFromSource = (value: string): "Draft" | "Approved" => {
    const normalized = String(value || "")
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    if (normalized === "angebot") return "Draft";
    if (["verkaufsauftrag", "sales order", "sale order", "sipariste", "siparis", "auftrag"].includes(normalized)) {
        return "Approved";
    }
    return "Draft";
};

const stripHtml = (value: string) =>
    String(value || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

const normalizePerson = (value: string) =>
    String(value || "")
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9@.]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const employeeScore = (employee: any, rawNameOrEmail: string) => {
    const raw = normalizePerson(rawNameOrEmail);
    if (!raw) return 0;
    const fullName = normalizePerson(`${employee.firstName || ""} ${employee.lastName || ""}`);
    const reversedName = normalizePerson(`${employee.lastName || ""} ${employee.firstName || ""}`);
    const email = normalizePerson(employee.email || "");
    const emailLocal = email.split("@")[0]?.replace(/[._-]+/g, " ") || "";
    if (email === raw) return 100;
    if (fullName === raw || reversedName === raw) return 90;
    if (emailLocal === raw.replace(/[._-]+/g, " ")) return 80;
    if (email.startsWith(raw.replace(/\s+/g, "."))) return 70;
    if (raw.includes(fullName) || fullName.includes(raw)) return 60;
    return 0;
};

// Load the tenant's active employee directory once so name/email matching during
// an import is done in memory instead of re-querying every row (avoids N+1).
const loadActiveEmployees = (tx: any, tenantId: string) =>
    tx.employee.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, firstName: true, lastName: true, email: true },
    });

const resolveEmployeeForName = (employees: any[], rawNameOrEmail: string, fallbackId: string) => {
    const raw = String(rawNameOrEmail || "").trim();
    if (!raw) return { id: fallbackId, name: null };
    const ranked = employees
        .map((employee: any) => ({ employee, score: employeeScore(employee, raw) }))
        .sort((a: any, b: any) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score <= 0) return { id: fallbackId, name: raw };
    return {
        id: best.employee.id,
        name: `${best.employee.firstName || ""} ${best.employee.lastName || ""}`.trim() || best.employee.email || raw,
    };
};

const createMessageLogs = async (tx: any, input: {
    tenantId: string;
    tenderId: string;
    fallbackEmployeeId: string;
    employees: any[];
    headers: HeaderInfo[];
    rows: CsvRow[];
}) => {
    const seen = new Set<string>();
    for (const row of input.rows) {
        const content = stripHtml(valueAt(input.headers, row, "messageContent") || valueAt(input.headers, row, "messages"));
        const attachmentName = valueAt(input.headers, row, "messageAttachments") || valueAt(input.headers, row, "messageAttachmentDocument");
        const author = valueAt(input.headers, row, "messageAuthor");
        const messageDate = parseDate(valueAt(input.headers, row, "messageDate"));
        const body = content || attachmentName;
        if (!body) continue;
        const key = `${author}|${messageDate?.toISOString() || ""}|${body}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const employee = resolveEmployeeForName(input.employees, author, input.fallbackEmployeeId);
        await tx.tenderActivityLog.create({
            data: {
                id: nanoid(12),
                tenantId: input.tenantId,
                tenderId: input.tenderId,
                employeeId: employee.id,
                actionType: "TENDER_NOTE",
                fieldName: attachmentName ? "messageAttachment" : "message",
                oldValue: null,
                newValue: attachmentName || null,
                description: body,
                ...(messageDate ? { createdAt: messageDate } : {}),
            },
        });
    }
};

export class ImportSalesOrderCsvUseCase {
    async execute(input: {
        tenantId: string;
        employeeId: string;
        csvContent: string;
        fileName?: string | null;
    }) {
        const parsed = parseCsv(input.csvContent);
        if (parsed.length < 2) {
            throw new Error("CSV dosyasında içe aktarılacak satır bulunamadı.");
        }

        const headerRow = parsed[0] || [];
        const headers: HeaderInfo[] = headerRow.map((raw) => {
            const normalized = normalizeHeader(raw);
            return { raw, normalized, canonical: headerLookup.get(normalized) };
        });
        const rows = parsed.slice(1);
        const groups = new Map<string, ImportGroup>();

        rows.forEach((row, index) => {
            const orderReference = valueAt(headers, row, "orderReference") || `CSV-${Date.now()}-${index + 1}`;
            const existing = groups.get(orderReference);
            if (existing) {
                existing.rows.push(row);
            } else {
                groups.set(orderReference, { orderReference, rows: [row] });
            }
        });

        const imported = await prisma.$transaction(async (tx) => {
            const tenders: any[] = [];
            let createdCustomers = 0;
            let createdArticles = 0;
            let createdPositions = 0;

            const employees = await loadActiveEmployees(tx, input.tenantId);

            for (const group of groups.values()) {
                const firstRow = group.rows[0]!;
                const customerName = firstValue(headers, group.rows, "customerName")
                    || firstValue(headers, group.rows, "billingAddress")
                    || "Imported customer";
                const address = firstValue(headers, group.rows, "billingAddress")
                    || firstValue(headers, group.rows, "shippingAddress")
                    || null;

                let customer: any = await (tx as any).customer.findFirst({
                    where: { tenantId: input.tenantId, companyName: customerName },
                    select: { id: true },
                });
                if (!customer) {
                    customer = await (tx as any).customer.create({
                        data: {
                            id: nanoid(8),
                            tenantId: input.tenantId,
                            companyName: customerName,
                            segment: "Imported",
                            address,
                            isActive: true,
                        },
                        select: { id: true },
                    });
                    createdCustomers += 1;
                }

                const salespersonName = firstValue(headers, group.rows, "salesperson");
                const salespersonEmployee = resolveEmployeeForName(employees, salespersonName, input.employeeId);

                const existingVersions = await (tx as any).tender.aggregate({
                    where: { tenantId: input.tenantId, tenderNumber: group.orderReference },
                    _max: { version: true },
                });
                const tenderId = nanoid(10);
                const sourceStatus = firstValue(headers, group.rows, "status");
                const tender = await (tx as any).tender.create({
                    data: {
                        id: tenderId,
                        tenantId: input.tenantId,
                        customerId: customer.id,
                        tenderNumber: group.orderReference,
                        version: Number(existingVersions._max.version || 0) + 1,
                        format: "CRBX",
                        status: normalizeTenderStatusFromSource(sourceStatus),
                        validUntil: parseDate(firstValue(headers, group.rows, "validUntil")),
                        createdByEmployeeId: salespersonEmployee.id,
                        sourceCreatedAt: parseDate(firstValue(headers, group.rows, "createdAt")),
                        orderDate: parseDate(firstValue(headers, group.rows, "orderDate")),
                        billingAddress: firstValue(headers, group.rows, "billingAddress") || null,
                        deliveryAddress: firstValue(headers, group.rows, "shippingAddress") || null,
                        internalDeliveryDate: parseDate(firstValue(headers, group.rows, "internalDeliveryDate")),
                        priceList: firstValue(headers, group.rows, "priceList") || null,
                        paymentTerms: firstValue(headers, group.rows, "paymentTerms") || null,
                        commissionNumber: firstValue(headers, group.rows, "commissionNumber") || null,
                        salespersonName: salespersonEmployee.name || salespersonName || null,
                        sourceStatus: sourceStatus || null,
                        sourceCompany: firstValue(headers, group.rows, "company") || null,
                        shippingTerms: firstValue(headers, group.rows, "shippingTerms") || null,
                        shippingWeight: parseNumber(firstValue(headers, group.rows, "shippingWeight")),
                        fiscalPosition: firstValue(headers, group.rows, "fiscalPosition") || null,
                        salesTeam: firstValue(headers, group.rows, "salesTeam") || null,
                        onlineSignature: parseBoolean(firstValue(headers, group.rows, "onlineSignature")),
                        onlinePayment: parseBoolean(firstValue(headers, group.rows, "onlinePayment")),
                        coverLetter: valueAt(headers, firstRow, "text") || null,
                        sourceTotal: parseNumber(firstValue(headers, group.rows, "total")),
                        sourceNetAmount: parseNumber(firstValue(headers, group.rows, "netAmount")),
                        sourceTaxAmount: parseNumber(firstValue(headers, group.rows, "taxAmount")),
                        sourceRecurringTotal: parseNumber(firstValue(headers, group.rows, "recurringTotal")),
                        sourceMargin: parseNumber(firstValue(headers, group.rows, "margin")),
                    },
                });

                for (let index = 0; index < group.rows.length; index += 1) {
                    const row = group.rows[index]!;
                    const product = valueAt(headers, row, "product");
                    const description = valueAt(headers, row, "description");
                    const quantity = parseNumber(valueAt(headers, row, "quantity"));
                    const unitPrice = parseNumber(valueAt(headers, row, "unitPrice"));
                    const unit = valueAt(headers, row, "unit") || "pcs";
                    const imageUrl = valueAt(headers, row, "imageUrl") || null;

                    if (!product && !description && !quantity && !unitPrice) continue;

                    const articleCode = safeArticleCode(product, description, index);
                    let article: any = await (tx as any).article.findFirst({
                        where: { tenantId: input.tenantId, articleCode },
                        select: { id: true },
                    });
                    if (!article) {
                        article = await (tx as any).article.create({
                            data: {
                                id: nanoid(10),
                                tenantId: input.tenantId,
                                articleCode,
                                name: product || firstDescriptionLine(description) || articleCode,
                                description: description || null,
                                baseCost: unitPrice,
                                unit,
                                imageUrl,
                                category: "Imported",
                                status: "ACTIVE",
                                isActive: true,
                            },
                            select: { id: true },
                        });
                        createdArticles += 1;
                    }

                    await (tx as any).position.create({
                        data: {
                            id: nanoid(10),
                            tenantId: input.tenantId,
                            tenderId,
                            rowType: "PRODUCT",
                            sourceArticleId: article.id,
                            displayOrder: (index + 1) * 1000,
                            positionNumber: String(index + 1),
                            shortDescription: product || firstDescriptionLine(description) || articleCode,
                            longDescription: description || null,
                            hierarchyLevel: 0,
                            quantity: quantity || 1,
                            unit,
                            unitPrice,
                            discount: parseNumber(valueAt(headers, row, "discount")),
                            taxRate: parseNumber(valueAt(headers, row, "tax")),
                            imageUrl,
                        },
                    });
                    createdPositions += 1;
                }

                await (tx as any).customerActivity.create({
                    data: {
                        id: nanoid(10),
                        customerId: customer.id,
                        employeeId: input.employeeId,
                        activityType: "TENDER_IMPORTED",
                        description: `Verkaufsauftrag erstellt: ${group.orderReference}`,
                        referenceId: tenderId,
                        activityDate: new Date(),
                    },
                });

                await (tx as any).tenderActivityLog.create({
                    data: {
                        id: nanoid(12),
                        tenantId: input.tenantId,
                        tenderId,
                        employeeId: input.employeeId,
                        actionType: "SALES_ORDER_CSV_IMPORTED",
                        fieldName: "csv",
                        oldValue: null,
                        newValue: input.fileName || null,
                        description: `Verkaufsauftrag erstellt. CSV-Zeilen: ${group.rows.length}.`,
                    },
                });

                tenders.push(tender);
            }

            return {
                tenders,
                summary: {
                    tenderCount: tenders.length,
                    createdCustomers,
                    createdArticles,
                    createdPositions,
                    sourceRows: rows.length,
                },
            };
        });

        return imported;
    }
}
