"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderRepository = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Tender_1 = require("../../domain/entities/Tender");
const customerAddress_1 = require("../../application/utils/customerAddress");
const nanoid_1 = require("nanoid");
const documentNumber_1 = require("../../shared/documentNumber");
/**
 * Gueltigkeitsdatum einer KOPIE: ein noch laufendes Datum wird uebernommen, ein
 * abgelaufenes auf einen Monat ab heute gesetzt — genau die Frist, die eine neu
 * angelegte Offerte bekommt. Ohne das kaeme die frische Kopie als "Abgelaufen"
 * auf die Welt (isExpiredTender liest validUntil). Ohne Datum bleibt es leer.
 */
const copiedValidUntil = (validUntil) => {
    if (!validUntil)
        return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (validUntil.getTime() >= today.getTime())
        return validUntil;
    const refreshed = new Date();
    refreshed.setMonth(refreshed.getMonth() + 1);
    return refreshed;
};
// Liste tablosunun çizdiği kolonlar artık `findLeanList` içindeki tek ham
// sorguda seçiliyor. Tam gövdedeki coverLetter / closingNote / closingImages
// LONGTEXT'tir — closingImages data-URI (base64 görsel) dizisi tutar, yani satır
// başına megabaytlarca veri; liste hiçbirini kullanmıyor.
//
// Tam gövde — `fields=list` göndermeyen çağıranlar (uyarı yığını, PDF/rapor
// yolları) bu şekle bağlı.
const TENDER_FULL_SELECT = {
    id: true,
    tenantId: true,
    customerId: true,
    tenderNumber: true,
    version: true,
    format: true,
    status: true,
    createdByEmployeeId: true,
    createdAt: true,
    projectId: true,
    validUntil: true,
    sourceCreatedAt: true,
    orderDate: true,
    billingAddress: true,
    installationAddress: true,
    deliveryAddress: true,
    billingSameAsInstallation: true,
    directDiscount: true,
    directDiscountLabel: true,
    extraDiscount: true,
    extraDiscountLabel: true,
    totalDiscounts: true,
    paymentStages: true,
    internalDeliveryDate: true,
    priceList: true,
    paymentTerms: true,
    commissionNumber: true,
    customerReference: true,
    currency: true,
    salespersonName: true,
    // Manuell erfasster Kunde (OSP-Import) — Name/Adresse/E-Mail direkt am
    // Beleg, ohne CRM-Kunden.
    manualCustomerName: true,
    manualCustomerEmail: true,
    manualCustomerAddress: true,
    sourceStatus: true,
    sourceCompany: true,
    shippingTerms: true,
    shippingWeight: true,
    fiscalPosition: true,
    salesTeam: true,
    onlineSignature: true,
    onlinePayment: true,
    coverLetter: true,
    closingNote: true,
    closingImages: true,
    sourceTotal: true,
    sourceNetAmount: true,
    sourceTaxAmount: true,
    sourceRecurringTotal: true,
    sourceMargin: true,
    ccEmails: true,
    offerMailSentAt: true,
    offerAcceptedAt: true,
    offerMailRecipient: true,
    offerAcceptanceToken: true,
    customer: { select: { companyName: true } },
    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
};
// The offer page does not need the potentially multi-megabyte PDF blocks on its
// critical path once an offer has become a read-only sales order. They are
// fetched from the dedicated PDF-content endpoint only when the user opens the
// PDF tab, exports the document or sends it by e-mail.
const { coverLetter: _coverLetter, closingNote: _closingNote, closingImages: _closingImages, ...TENDER_WITHOUT_PDF_CONTENT_SELECT } = TENDER_FULL_SELECT;
const TENDER_DETAIL_CUSTOMER_SELECT = {
    id: true,
    companyName: true,
    addressName: true,
    address: true,
    addressSupplement: true,
    postalCode: true,
    city: true,
    state: true,
    country: true,
    mainPhone: true,
    mainEmail: true,
    taxNumber: true,
};
// "Sipariş" sayılan kaynak durumları (frontend'deki isSourceSalesOrder ile aynı
// ham değerler). Hem Prisma hem ham SQL yolu bu tek listeyi kullanır.
const ORDER_SOURCE_VALUES = [
    'Verkaufsauftrag', 'Auftrag', 'sales order', 'sale order',
    'sales_order', 'sale_order', 'Sipariş', 'Siparişte', 'Siparis', 'Sipariste',
];
class TenderRepository {
    /**
     * `fields=list` yolunun WHERE parçası — Prisma nesnesinin ham SQL karşılığı.
     * Liste sorgusu ile sayım sorgusu AYNI parçayı kullanır, böylece ikisi
     * paralel koşabilir ve yine de birebir aynı kümeyi görürler.
     */
    buildLeanWhere(filter) {
        const conditions = [client_1.Prisma.sql `t.tenantId = ${filter.tenantId}`];
        if (filter.customerId)
            conditions.push(client_1.Prisma.sql `t.customerId = ${filter.customerId}`);
        if (filter.status)
            conditions.push(client_1.Prisma.sql `t.status = ${filter.status}`);
        // Genel arama teklif numarasında; Prisma `contains` gibi joker kaçışı yok
        // (davranış birebir korunuyor), değer yine parametre olarak bağlanıyor.
        // Eski kodu (A-2026-4474) elinde olan kullanıcı da kaydı bulabilsin diye
        // arama `legacyNumber`ı da tarar.
        if (filter.search)
            conditions.push(client_1.Prisma.sql `(t.tenderNumber LIKE ${`%${filter.search}%`} OR t.legacyNumber LIKE ${`%${filter.search}%`})`);
        if (filter.tenderNumber)
            conditions.push(client_1.Prisma.sql `(t.tenderNumber LIKE ${`%${filter.tenderNumber}%`} OR t.legacyNumber LIKE ${`%${filter.tenderNumber}%`})`);
        if (filter.customerName)
            conditions.push(client_1.Prisma.sql `c.companyName LIKE ${`%${filter.customerName}%`}`);
        if (filter.creatorName) {
            const pattern = `%${filter.creatorName}%`;
            conditions.push(client_1.Prisma.sql `(e.firstName LIKE ${pattern} OR e.lastName LIKE ${pattern} OR e.email LIKE ${pattern})`);
        }
        if (filter.orderState === 'order') {
            conditions.push(client_1.Prisma.sql `(t.projectId IS NOT NULL OR t.sourceStatus IN (${client_1.Prisma.join(ORDER_SOURCE_VALUES)}))`);
        }
        else if (filter.orderState === 'draft') {
            // NULL sourceStatus üç değerli mantıkta NOT IN ile elenirdi; açık
            // NULL dalı taslakların düşmesini engeller.
            conditions.push(client_1.Prisma.sql `t.projectId IS NULL`);
            conditions.push(client_1.Prisma.sql `(t.sourceStatus IS NULL OR t.sourceStatus NOT IN (${client_1.Prisma.join(ORDER_SOURCE_VALUES)}))`);
        }
        if (filter.mailSent === 'yes')
            conditions.push(client_1.Prisma.sql `t.offerMailSentAt IS NOT NULL`);
        else if (filter.mailSent === 'no')
            conditions.push(client_1.Prisma.sql `t.offerMailSentAt IS NULL`);
        return client_1.Prisma.join(conditions, ' AND ');
    }
    /**
     * Liste sayfasını TEK ifadede getirir: müşteri adı ve oluşturan kişi JOIN'le,
     * pozisyon sayısı/tutarı ise ilişkili alt sorgularla gelir.
     *
     * Veritabanı uzak olduğu için maliyet sorgunun ağırlığı değil, ARDIŞIK tur
     * sayısı: her ifade ~100 ms. Eskiden bu yol 5 ifade harcıyordu (findMany +
     * count + customer ilişkisi + createdBy ilişkisi + gruplu tutar sorgusu) ve
     * son ikisi sayfa id'lerine bağlı olduğu için zorunlu olarak ardışıktı.
     * Şimdi liste ve sayım paralel iki ifade — pratikte tek tur.
     */
    async findLeanList(filter, orderBySql, page, pageSize) {
        const whereSql = this.buildLeanWhere(filter);
        const limitSql = page && pageSize
            ? client_1.Prisma.sql `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
            : client_1.Prisma.empty;
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    t.id, t.tenderNumber, t.version, t.projectId, t.sourceStatus,
                    t.createdByEmployeeId, t.currency, t.createdAt, t.offerMailSentAt,
                    t.validUntil, t.offerAcceptedAt, t.commissionNumber,
                    COALESCE(NULLIF(TRIM(t.manualCustomerName), ''), c.companyName) AS customerName,
                    e.firstName AS creatorFirstName,
                    e.lastName AS creatorLastName,
                    e.email AS creatorEmail,
                    (SELECT COUNT(*) FROM Position p WHERE p.tenderId = t.id) AS positionCount,
                    /* Herkunft aus der OSP — als Unterabfragen, NICHT als JOIN:
                       ein JOIN könnte eine Offerte doppeln, wenn je zwei
                       OSP-Zeilen auf sie zeigten, und die Sayım-Abfrage daneben
                       müsste er mitmachen, um dieselbe Menge zu sehen. */
                    (SELECT o.reference FROM OspDocument o WHERE o.tenderId = t.id LIMIT 1) AS ospReference,
                    (SELECT o.revisedAt FROM OspDocument o WHERE o.tenderId = t.id LIMIT 1) AS ospRevisedAt,
                    (SELECT o.revisionSeenAt FROM OspDocument o WHERE o.tenderId = t.id LIMIT 1) AS ospRevisionSeenAt,
                    (
                        SELECT COALESCE(SUM(
                            CASE
                                WHEN p.unitPrice IS NOT NULL AND p.quantity > 0
                                    THEN p.quantity * p.unitPrice * (1 - COALESCE(p.discount, 0) / 100)
                                ELSE GREATEST(0, COALESCE(ci.totalCalculatedPrice, 0))
                            END
                        ), 0)
                        FROM Position p
                        LEFT JOIN CalculationItem ci ON ci.positionId = p.id
                        WHERE p.tenderId = t.id
                    ) AS grandTotal
                FROM Tender t
                LEFT JOIN Customer c ON c.id = t.customerId
                LEFT JOIN Employee e ON e.id = t.createdByEmployeeId
                WHERE ${whereSql}
                ${orderBySql}
                ${limitSql}
            `),
            page && pageSize
                ? prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT COUNT(*) AS total
                    FROM Tender t
                    LEFT JOIN Customer c ON c.id = t.customerId
                    LEFT JOIN Employee e ON e.id = t.createdByEmployeeId
                    WHERE ${whereSql}
                `)
                : Promise.resolve([{ total: 0 }]),
        ]);
        const items = rows.map((row) => ({
            id: row.id,
            tenderNumber: row.tenderNumber,
            version: Number(row.version),
            projectId: row.projectId ?? null,
            sourceStatus: row.sourceStatus ?? null,
            customerName: row.customerName ?? null,
            createdByEmployeeId: row.createdByEmployeeId,
            createdByName: row.creatorFirstName || row.creatorLastName
                ? `${row.creatorFirstName ?? ''} ${row.creatorLastName ?? ''}`.trim()
                : null,
            createdByEmail: row.creatorEmail ?? null,
            currency: row.currency ?? null,
            createdAt: row.createdAt,
            offerMailSentAt: row.offerMailSentAt ?? null,
            validUntil: row.validUntil ?? null,
            offerAcceptedAt: row.offerAcceptedAt ?? null,
            commissionNumber: row.commissionNumber ?? null,
            positionCount: Number(row.positionCount ?? 0),
            grandTotal: Number(row.grandTotal ?? 0),
            ospReference: row.ospReference ?? null,
            ospRevisedAt: row.ospRevisedAt ?? null,
            ospRevisionSeenAt: row.ospRevisionSeenAt ?? null,
        }));
        return { items, total: Number(countRows[0]?.total ?? 0) };
    }
    // Sayfadaki tekliflerin tutar/pozisyon sayısını TEK gruplu sorguda hesaplar.
    // Önceden her teklifin bütün pozisyonları (+ her biri için calculation satırı)
    // çekilip toplam JS'te reduce ediliyordu: yüzlerce pozisyonlu tekliflerde
    // sayfa başına binlerce satır. CASE ifadesi eski reduce mantığının birebir
    // karşılığı — birim fiyat varsa iskontolu satır tutarı, yoksa hesaplanan fiyat.
    async loadPositionTotals(tenderIds) {
        const totals = new Map();
        if (tenderIds.length === 0)
            return totals;
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT
                p.tenderId AS tenderId,
                COUNT(*) AS positionCount,
                SUM(
                    CASE
                        WHEN p.unitPrice IS NOT NULL AND p.quantity > 0
                            THEN p.quantity * p.unitPrice * (1 - COALESCE(p.discount, 0) / 100)
                        ELSE GREATEST(0, COALESCE(c.totalCalculatedPrice, 0))
                    END
                ) AS grandTotal
            FROM Position p
            LEFT JOIN CalculationItem c ON c.positionId = p.id
            WHERE p.tenderId IN (${client_1.Prisma.join(tenderIds)})
            GROUP BY p.tenderId
        `);
        for (const row of rows) {
            totals.set(row.tenderId, {
                positionCount: Number(row.positionCount),
                grandTotal: Number(row.grandTotal ?? 0),
            });
        }
        return totals;
    }
    mapToEntity(data) {
        return new Tender_1.Tender(data.id, data.tenantId, data.customerId, data.tenderNumber, data.version, data.format, data.status, data.createdByEmployeeId, data.createdAt, data.projectId, data.validUntil, data.offerMailSentAt, data.offerAcceptedAt, data.offerMailRecipient, data.offerAcceptanceToken, data.sourceCreatedAt, data.orderDate, data.billingAddress, data.deliveryAddress, data.internalDeliveryDate, data.priceList, data.paymentTerms, data.commissionNumber, data.salespersonName, data.sourceStatus, data.sourceCompany, data.shippingTerms, data.shippingWeight, data.fiscalPosition, data.salesTeam, data.onlineSignature, data.onlinePayment, data.coverLetter, data.closingNote, data.closingImages, data.sourceTotal, data.sourceNetAmount, data.sourceTaxAmount, data.sourceRecurringTotal, data.sourceMargin, data.billingSameAsInstallation, data.installationAddress, data.directDiscount, data.currency, data.directDiscountLabel, data.extraDiscount, data.extraDiscountLabel, data.totalDiscounts, data.paymentStages, data.customerReference, data.legacyNumber);
    }
    async create(tenderData) {
        const data = await prisma_client_1.default.tender.create({
            data: tenderData
        });
        return this.mapToEntity(data);
    }
    async findById(id, tenantId, options) {
        const selectedFields = options?.includePdfContent === false
            ? TENDER_WITHOUT_PDF_CONTENT_SELECT
            : TENDER_FULL_SELECT;
        const { customer: _customerRelation, createdBy: _createdByRelation, ...tenderFields } = selectedFields;
        // Scoped by both id and tenantId (findFirst, since the composite is not a
        // unique key). Cross-tenant ids simply resolve to null.
        const data = await prisma_client_1.default.tender.findFirst({
            where: { id, tenantId },
            select: tenderFields,
        });
        if (!data)
            return null;
        // MariaDB cannot use Prisma's relationLoadStrategy=join. Fetch the three
        // small relations in parallel so detail loading costs two remote DB
        // rounds instead of one round per relation.
        const [customer, createdBy, salesOrder] = await Promise.all([
            data.customerId
                ? prisma_client_1.default.customer.findUnique({
                    where: { id: data.customerId },
                    select: TENDER_DETAIL_CUSTOMER_SELECT,
                })
                : Promise.resolve(null),
            data.createdByEmployeeId
                ? prisma_client_1.default.employee.findUnique({
                    where: { id: data.createdByEmployeeId },
                    select: { id: true, firstName: true, lastName: true, email: true },
                })
                : Promise.resolve(null),
            prisma_client_1.default.salesOrder.findFirst({
                where: { tenderId: id },
                select: { id: true, orderNumber: true, projectId: true },
            }),
        ]);
        const hydrated = { ...data, customer, createdBy, salesOrder };
        const entity = this.mapToEntity(hydrated);
        entity.salesOrder = salesOrder ?? null;
        entity.pdfContentDeferred = options?.includePdfContent === false;
        // CC-Empfänger der Offerte (JSON-Spalte). Der Entity-Konstruktor kennt
        // das Feld nicht — es wird, wie die Kundenfelder unten, nach dem Mappen
        // angehängt und ist für die Oberfläche IMMER ein Array.
        entity.ccEmails = Array.isArray(data.ccEmails) ? data.ccEmails : [];
        // Von Hand erfasster Kunde: die manualCustomer*-Spalten sind die
        // OFFERTEN-EIGENEN Angaben und gelten VOR dem Kundenstamm (05.09.2026).
        // Ohne CRM-Kunden tragen sie die Offerte allein; mit CRM-Kunden sind sie
        // die nur hier geltende Abweichung — der Kundenstamm bleibt unberührt.
        // Die Oberfläche und das Angebots-PDF lesen weiter dieselben Felder.
        const manualName = String(data.manualCustomerName ?? '').trim();
        const manualAddress = String(data.manualCustomerAddress ?? '').trim();
        const manualEmail = String(data.manualCustomerEmail ?? '').trim();
        // Die Rohwerte gehen mit (der Entity-Konstruktor kennt sie nicht): die
        // Offertmaske zeigt daran, welche Angabe von Hand erfasst wurde.
        entity.manualCustomerName = manualName || null;
        entity.manualCustomerEmail = manualEmail || null;
        entity.manualCustomerAddress = manualAddress || null;
        entity.customerName = manualName || customer?.companyName || null;
        // The customer's primary address (street / postal + city / country) formatted
        // as a single multi-line string — the default for the tender's address slot.
        entity.customerAddress = manualAddress || (0, customerAddress_1.formatCustomerAddress)(customer) || null;
        entity.customerEmail = manualEmail || customer?.mainEmail || null;
        entity.customerPhone = customer?.mainPhone ?? null;
        entity.customerTaxNumber = customer?.taxNumber ?? null;
        entity.createdByName = createdBy
            ? `${createdBy.firstName} ${createdBy.lastName}`
            : null;
        entity.createdByEmail = createdBy?.email ?? null;
        return entity;
    }
    async findAll(filter) {
        const where = { tenantId: filter.tenantId };
        if (filter.customerId)
            where.customerId = filter.customerId;
        if (filter.status)
            where.status = filter.status;
        if (filter.search) {
            where.OR = [
                { tenderNumber: { contains: filter.search } },
                { legacyNumber: { contains: filter.search } },
            ];
        }
        // Kolon bazlı filtreler — üstteki genel arama ile AND'lenir (MySQL collation
        // varsayılan olarak büyük/küçük harf duyarsız, ayrıca `mode` gerekmez).
        if (filter.tenderNumber) {
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { tenderNumber: { contains: filter.tenderNumber } },
                        { legacyNumber: { contains: filter.tenderNumber } },
                    ],
                },
            ];
        }
        if (filter.customerName) {
            where.customer = { is: { companyName: { contains: filter.customerName } } };
        }
        if (filter.creatorName) {
            where.createdBy = {
                is: {
                    OR: [
                        { firstName: { contains: filter.creatorName } },
                        { lastName: { contains: filter.creatorName } },
                        { email: { contains: filter.creatorName } },
                    ],
                },
            };
        }
        // "Sipariş" durumu — projeye bağlanmış VEYA kaynağı bir satış siparişi olan
        // kayıtlar. Genel arama üstteki `where.OR`'u kullandığından bu koşul
        // `where.AND`'e eklenir.
        const andConditions = [];
        if (filter.orderState === 'order') {
            andConditions.push({
                OR: [
                    { projectId: { not: null } },
                    { sourceStatus: { in: ORDER_SOURCE_VALUES } },
                ],
            });
        }
        else if (filter.orderState === 'draft') {
            andConditions.push({ projectId: null });
            // NULL sourceStatus, `notIn` ile üç değerli mantıkta elenirdi; açık NULL
            // dalıyla taslak kayıtların dışarıda kalması engellenir.
            andConditions.push({
                OR: [
                    { sourceStatus: null },
                    { sourceStatus: { notIn: ORDER_SOURCE_VALUES } },
                ],
            });
        }
        if (andConditions.length > 0)
            where.AND = andConditions;
        if (filter.mailSent === 'yes')
            where.offerMailSentAt = { not: null };
        else if (filter.mailSent === 'no')
            where.offerMailSentAt = null;
        // Sıralama — yalnızca DB kolonlarına (hesaplanan grandTotal hariç) izin ver.
        const sortDir = filter.sortDirection === 'asc' ? 'asc' : 'desc';
        let orderBy = { createdAt: 'desc' };
        // Ham SQL yolunun karşılığı. Kolon adları SABİT literaller (kullanıcı
        // girdisi yalnızca yukarıdaki switch'ten geçen sabit bir anahtar).
        let orderBySql = client_1.Prisma.sql `ORDER BY t.createdAt DESC`;
        const dirSql = sortDir === 'asc' ? client_1.Prisma.sql `ASC` : client_1.Prisma.sql `DESC`;
        switch (filter.sortBy) {
            case 'tenderNumber':
                orderBy = { tenderNumber: sortDir };
                orderBySql = client_1.Prisma.sql `ORDER BY t.tenderNumber ${dirSql}`;
                break;
            case 'status':
                orderBy = { status: sortDir };
                orderBySql = client_1.Prisma.sql `ORDER BY t.status ${dirSql}`;
                break;
            case 'customerName':
                orderBy = { customer: { companyName: sortDir } };
                orderBySql = client_1.Prisma.sql `ORDER BY c.companyName ${dirSql}`;
                break;
            case 'createdAt':
                orderBy = { createdAt: sortDir };
                orderBySql = client_1.Prisma.sql `ORDER BY t.createdAt ${dirSql}`;
                break;
        }
        const page = filter.page && filter.page > 0 ? filter.page : undefined;
        const pageSize = filter.pageSize && filter.pageSize > 0 ? Math.min(filter.pageSize, 100) : undefined;
        const leanList = filter.fields === 'list';
        // Liste yolu tek ham sorguya iner; tam gövde yolu Prisma'da kalır.
        if (leanList) {
            const { items, total } = await this.findLeanList(filter, orderBySql, page, pageSize);
            if (page && pageSize) {
                return {
                    items,
                    total,
                    page,
                    pageSize,
                    totalPages: Math.max(1, Math.ceil(total / pageSize)),
                };
            }
            return items;
        }
        const [data, total] = await Promise.all([
            prisma_client_1.default.tender.findMany({
                where,
                // A list row never renders the PDF content blocks, and they are the
                // heaviest columns on the table by far — one offer carrying closing
                // images made up 2 MB of a 50-row, 2.06 MB response. Whoever needs
                // them (the PDF tab, export, mail) reads them per offer from
                // /tenders/:id/pdf-content instead.
                select: TENDER_WITHOUT_PDF_CONTENT_SELECT,
                orderBy,
                ...(page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
            }),
            page && pageSize ? prisma_client_1.default.tender.count({ where }) : Promise.resolve(0),
        ]);
        // Tutarlar sayfadaki teklifler için tek gruplu sorguda gelir.
        const positionTotals = await this.loadPositionTotals(data.map((d) => d.id));
        const items = data.map((d) => {
            const totals = positionTotals.get(d.id);
            // Wie in findById: die offerteneigene Angabe gilt vor dem Stamm.
            const customerName = String(d.manualCustomerName ?? '').trim() || d.customer?.companyName || null;
            const createdByName = d.createdBy
                ? `${d.createdBy.firstName} ${d.createdBy.lastName}`.trim()
                : null;
            const createdByEmail = d.createdBy?.email ?? null;
            const item = this.mapToEntity(d);
            item.customerName = customerName;
            item.createdByName = createdByName;
            item.createdByEmail = createdByEmail;
            item.positionCount = totals?.positionCount ?? 0;
            item.grandTotal = totals?.grandTotal ?? 0;
            return item;
        });
        if (page && pageSize) {
            return {
                items,
                total,
                page,
                pageSize,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
            };
        }
        return items;
    }
    async delete(id, tenantId) {
        await prisma_client_1.default.$transaction(async (tx) => {
            // Only delete when the tender belongs to this tenant.
            const owned = await tx.tender.findFirst({
                where: { id, tenantId },
                select: { id: true }
            });
            if (!owned) {
                throw new Error("Teklif bulunamadı veya bu şirkete ait değil.");
            }
            const positions = await tx.position.findMany({
                where: { tenderId: id },
                select: { id: true }
            });
            const positionIds = positions.map(p => p.id);
            if (positionIds.length > 0) {
                await tx.positionArticleMapping.deleteMany({ where: { positionId: { in: positionIds } } });
                await tx.calculationItem.deleteMany({ where: { positionId: { in: positionIds } } });
                await tx.position.deleteMany({ where: { tenderId: id } });
            }
            // Eine aus der OSP entstandene Offerte gibt beim Löschen ihre
            // OSP-Zeile wieder frei: ohne tenderId bietet /sales/osp erneut
            // "Offerte erstellen" an (der Import selbst prüft ohnehin, ob die
            // Offerte noch existiert — hier wird die Liste ehrlich gehalten).
            await tx.ospDocument.updateMany({
                where: { tenderId: id },
                data: { tenderId: null, tenderNumber: null },
            });
            await tx.tender.delete({ where: { id } });
        });
    }
    async updateStatus(id, status, tenantId) {
        // Update only the row matching id + tenantId; if nothing matched the
        // tender either doesn't exist or belongs to another tenant.
        const result = await prisma_client_1.default.tender.updateMany({
            where: { id, tenantId },
            data: { status }
        });
        if (result.count === 0) {
            throw new Error("Teklif bulunamadı veya bu şirkete ait değil.");
        }
        const data = await prisma_client_1.default.tender.findUniqueOrThrow({ where: { id } });
        return this.mapToEntity(data);
    }
    /**
     * Kopf- und Positionsdaten einer Offerte in eine NEUE Offerte schreiben.
     *
     * Zwei Wege teilen sich diesen Rumpf: die neue VERSION (gleiche AN-Nummer,
     * Version + 1) und die KOPIE (frische AN-Nummer, Version 1). Alles, was die
     * beiden trennt, kommt ueber `overrides` herein; der Feldkatalog steht nur
     * einmal da, damit eine neue Spalte nicht in einem der beiden Wege
     * vergessen wird.
     */
    async copyTenderRecord(tx, existingTender, newTenderId, overrides) {
        const createdTender = await tx.tender.create({
            data: {
                id: newTenderId,
                tenantId: existingTender.tenantId,
                customerId: existingTender.customerId,
                tenderNumber: overrides.tenderNumber,
                version: overrides.version,
                format: existingTender.format,
                status: 'Draft',
                createdByEmployeeId: overrides.createdByEmployeeId,
                validUntil: overrides.validUntil,
                sourceCreatedAt: existingTender.sourceCreatedAt,
                orderDate: existingTender.orderDate,
                billingAddress: existingTender.billingAddress,
                installationAddress: existingTender.installationAddress,
                deliveryAddress: existingTender.deliveryAddress,
                billingSameAsInstallation: existingTender.billingSameAsInstallation,
                directDiscount: existingTender.directDiscount,
                directDiscountLabel: existingTender.directDiscountLabel,
                extraDiscount: existingTender.extraDiscount,
                extraDiscountLabel: existingTender.extraDiscountLabel,
                totalDiscounts: existingTender.totalDiscounts,
                paymentStages: existingTender.paymentStages,
                internalDeliveryDate: existingTender.internalDeliveryDate,
                priceList: existingTender.priceList,
                paymentTerms: existingTender.paymentTerms,
                commissionNumber: existingTender.commissionNumber,
                customerReference: existingTender.customerReference,
                currency: existingTender.currency,
                salespersonName: existingTender.salespersonName,
                // Eine Offerte kann OHNE CRM-Kunden leben (OSP-Import): dann
                // steht der Empfaenger in diesen drei Feldern. Ohne sie kaeme
                // die Kopie ohne Kunden auf die Welt.
                manualCustomerName: existingTender.manualCustomerName,
                manualCustomerEmail: existingTender.manualCustomerEmail,
                manualCustomerAddress: existingTender.manualCustomerAddress,
                // Json-Spalte: `null` verlangt bei Prisma Prisma.DbNull, also
                // wird das Feld bei leerer CC-Liste schlicht weggelassen.
                ccEmails: existingTender.ccEmails ?? undefined,
                sourceStatus: overrides.sourceStatus,
                sourceCompany: existingTender.sourceCompany,
                shippingTerms: existingTender.shippingTerms,
                shippingWeight: existingTender.shippingWeight,
                fiscalPosition: existingTender.fiscalPosition,
                salesTeam: existingTender.salesTeam,
                onlineSignature: existingTender.onlineSignature,
                onlinePayment: existingTender.onlinePayment,
                coverLetter: existingTender.coverLetter,
                closingNote: existingTender.closingNote,
                closingImages: existingTender.closingImages,
                sourceTotal: existingTender.sourceTotal,
                sourceNetAmount: existingTender.sourceNetAmount,
                sourceTaxAmount: existingTender.sourceTaxAmount,
                sourceRecurringTotal: existingTender.sourceRecurringTotal,
                sourceMargin: existingTender.sourceMargin,
                projectId: overrides.projectId,
            }
        });
        // Der Positionsbaum wird als Ganzes gespiegelt: erst fuer jede Zeile
        // eine neue Id reservieren, damit `parentPositionId` beim Schreiben
        // schon auf die KOPIE zeigt und nicht auf das Original.
        const idMapping = new Map();
        for (const pos of existingTender.positions) {
            idMapping.set(pos.id, (0, nanoid_1.nanoid)(10));
        }
        // Drei Sammel-Inserts statt drei pro Zeile: die Datenbank steht
        // entfernt, und eine Offerte mit 200 Zeilen haette sonst 600
        // Netzwerkrunden INNERHALB der Transaktion gebraucht (deren
        // Standardfrist 5 s betraegt).
        const positionRows = [];
        const calculationRows = [];
        const mappingRows = [];
        for (const pos of existingTender.positions) {
            const newPosId = idMapping.get(pos.id);
            const newParentId = pos.parentPositionId ? idMapping.get(pos.parentPositionId) || null : null;
            positionRows.push({
                id: newPosId,
                tenantId: pos.tenantId,
                tenderId: newTenderId,
                parentPositionId: newParentId,
                rowType: pos.rowType || 'SECTION',
                sourceArticleId: pos.sourceArticleId || null,
                displayOrder: pos.displayOrder ?? 0,
                npkCode: pos.npkCode || null,
                positionNumber: pos.positionNumber,
                shortDescription: pos.shortDescription,
                longDescription: pos.longDescription || null,
                quantity: pos.quantity,
                unit: pos.unit || null,
                hierarchyLevel: pos.hierarchyLevel,
                unitPrice: pos.unitPrice,
                discount: pos.discount,
                discounts: pos.discounts,
                taxRate: pos.taxRate,
                imageUrl: pos.imageUrl,
            });
            if (pos.calculation) {
                calculationRows.push({
                    id: (0, nanoid_1.nanoid)(8),
                    positionId: newPosId,
                    materialCost: pos.calculation.materialCost,
                    laborCost: pos.calculation.laborCost,
                    overheadCost: pos.calculation.overheadCost,
                    riskAmount: pos.calculation.riskAmount,
                    additionalCost: pos.calculation.additionalCost || 0,
                    profitMargin: pos.calculation.profitMargin,
                    totalCalculatedPrice: pos.calculation.totalCalculatedPrice,
                });
            }
            for (const mapping of pos.articleMappings || []) {
                mappingRows.push({
                    id: (0, nanoid_1.nanoid)(10),
                    positionId: newPosId,
                    articleId: mapping.articleId,
                    quantityMultiplier: mapping.quantityMultiplier,
                    discount: mapping.discount ?? 0,
                });
            }
        }
        // InnoDB prueft den Selbstbezug `parentPositionId` sofort, Zeile fuer
        // Zeile — in EINER Sammel-Einfuegung muessen Eltern also VOR ihren
        // Kindern stehen. Die Reihenfolge, in der die Zeilen aus der Datenbank
        // kommen, garantiert das nicht, deshalb der Baumdurchlauf.
        const orderedPositionRows = [];
        const rowsByParent = new Map();
        for (const row of positionRows) {
            const parentKey = row.parentPositionId ?? null;
            const bucket = rowsByParent.get(parentKey);
            if (bucket)
                bucket.push(row);
            else
                rowsByParent.set(parentKey, [row]);
        }
        const emitChildrenOf = (parentId) => {
            for (const row of rowsByParent.get(parentId) || []) {
                orderedPositionRows.push(row);
                emitChildrenOf(row.id);
            }
        };
        emitChildrenOf(null);
        // Sicherheitsnetz: haenge alles an, was der Durchlauf nicht erreicht hat
        // (ein Zyklus in den Altdaten), damit keine Zeile verloren geht.
        if (orderedPositionRows.length < positionRows.length) {
            const emitted = new Set(orderedPositionRows.map((row) => row.id));
            for (const row of positionRows) {
                if (!emitted.has(row.id))
                    orderedPositionRows.push(row);
            }
        }
        // Reihenfolge ist Pflicht: Kalkulation und Artikelzuordnung haengen als
        // Fremdschluessel an der Position.
        if (orderedPositionRows.length)
            await tx.position.createMany({ data: orderedPositionRows });
        if (calculationRows.length)
            await tx.calculationItem.createMany({ data: calculationRows });
        if (mappingRows.length)
            await tx.positionArticleMapping.createMany({ data: mappingRows });
        return createdTender;
    }
    /** Die zu kopierende Offerte samt vollem Positionsbaum. */
    async findTenderForCopy(tenderId, tenantId) {
        const existingTender = await prisma_client_1.default.tender.findFirst({
            where: { id: tenderId, tenantId },
            include: {
                positions: {
                    include: {
                        calculation: true,
                        articleMappings: true,
                    }
                }
            }
        });
        if (!existingTender)
            throw new Error("Kopyalanacak teklif bulunamadı.");
        return existingTender;
    }
    async createNextVersion(tenderId, newCreatedBy, tenantId) {
        const existingTender = await this.findTenderForCopy(tenderId, tenantId);
        const result = await prisma_client_1.default.$transaction(async (tx) => this.copyTenderRecord(tx, existingTender, (0, nanoid_1.nanoid)(10), {
            // Alle Versionen einer Offerte teilen sich dieselbe AN-Nummer;
            // nur der Zaehler dahinter steigt.
            tenderNumber: existingTender.tenderNumber,
            version: existingTender.version + 1,
            createdByEmployeeId: newCreatedBy,
            projectId: existingTender.projectId,
            sourceStatus: existingTender.sourceStatus,
            validUntil: existingTender.validUntil,
        }));
        return this.mapToEntity(result);
    }
    /**
     * Offerte KOPIEREN — dieselben Daten, aber ein EIGENER Beleg: frische
     * AN-Nummer, Version 1, Entwurf. (Die neue Version behaelt dagegen die
     * Nummer und zaehlt nur die Version hoch.)
     */
    async duplicate(tenderId, newCreatedBy, tenantId) {
        const existingTender = await this.findTenderForCopy(tenderId, tenantId);
        const result = await prisma_client_1.default.$transaction(async (tx) => {
            // Die Nummer wird IN dieser Transaktion gezogen: bricht das
            // Kopieren ab, bleibt keine Luecke in der Belegreihe zurueck.
            const tenderNumber = await (0, documentNumber_1.nextDocumentNumber)(existingTender.tenantId, 'QUOTE', tx);
            return this.copyTenderRecord(tx, existingTender, (0, nanoid_1.nanoid)(10), {
                tenderNumber,
                version: 1,
                createdByEmployeeId: newCreatedBy,
                // Die Kopie startet als ENTWURF: kein Projekt, kein
                // Auftragsstatus — sonst zeigten Liste und Detail sie sofort
                // als "Auftrag" (isOrderTender liest genau diese zwei Felder).
                projectId: null,
                sourceStatus: null,
                validUntil: copiedValidUntil(existingTender.validUntil),
            });
        });
        return this.mapToEntity(result);
    }
}
exports.TenderRepository = TenderRepository;
//# sourceMappingURL=TenderRepository.js.map