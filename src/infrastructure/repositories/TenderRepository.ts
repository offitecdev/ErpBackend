

import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client";
import { ITenderRepository, ITenderFilter, TenderListItem, TenderListRow } from "../../domain/repositories/ITenderRepository";
import { Tender } from "../../domain/entities/Tender";
import { formatCustomerAddress } from "../../application/utils/customerAddress";
import { nanoid } from "nanoid";

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
    offerMailSentAt: true,
    offerAcceptedAt: true,
    offerMailRecipient: true,
    offerAcceptanceToken: true,
    customer: { select: { companyName: true } },
    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

// The offer page does not need the potentially multi-megabyte PDF blocks on its
// critical path once an offer has become a read-only sales order. They are
// fetched from the dedicated PDF-content endpoint only when the user opens the
// PDF tab, exports the document or sends it by e-mail.
const {
    coverLetter: _coverLetter,
    closingNote: _closingNote,
    closingImages: _closingImages,
    ...TENDER_WITHOUT_PDF_CONTENT_SELECT
} = TENDER_FULL_SELECT;

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
} as const;

interface PositionTotalsRow {
    tenderId: string;
    positionCount: bigint | number;
    grandTotal: number | null;
}

// "Sipariş" sayılan kaynak durumları (frontend'deki isSourceSalesOrder ile aynı
// ham değerler). Hem Prisma hem ham SQL yolu bu tek listeyi kullanır.
const ORDER_SOURCE_VALUES = [
    'Verkaufsauftrag', 'Auftrag', 'sales order', 'sale order',
    'sales_order', 'sale_order', 'Sipariş', 'Siparişte', 'Siparis', 'Sipariste',
];

export class TenderRepository implements ITenderRepository {

    /**
     * `fields=list` yolunun WHERE parçası — Prisma nesnesinin ham SQL karşılığı.
     * Liste sorgusu ile sayım sorgusu AYNI parçayı kullanır, böylece ikisi
     * paralel koşabilir ve yine de birebir aynı kümeyi görürler.
     */
    private buildLeanWhere(filter: ITenderFilter): Prisma.Sql {
        const conditions: Prisma.Sql[] = [Prisma.sql`t.tenantId = ${filter.tenantId}`];

        if (filter.customerId) conditions.push(Prisma.sql`t.customerId = ${filter.customerId}`);
        if (filter.status) conditions.push(Prisma.sql`t.status = ${filter.status}`);
        // Genel arama teklif numarasında; Prisma `contains` gibi joker kaçışı yok
        // (davranış birebir korunuyor), değer yine parametre olarak bağlanıyor.
        // Eski kodu (A-2026-4474) elinde olan kullanıcı da kaydı bulabilsin diye
        // arama `legacyNumber`ı da tarar.
        if (filter.search) conditions.push(Prisma.sql`(t.tenderNumber LIKE ${`%${filter.search}%`} OR t.legacyNumber LIKE ${`%${filter.search}%`})`);
        if (filter.tenderNumber) conditions.push(Prisma.sql`(t.tenderNumber LIKE ${`%${filter.tenderNumber}%`} OR t.legacyNumber LIKE ${`%${filter.tenderNumber}%`})`);
        if (filter.customerName) conditions.push(Prisma.sql`c.companyName LIKE ${`%${filter.customerName}%`}`);
        if (filter.creatorName) {
            const pattern = `%${filter.creatorName}%`;
            conditions.push(Prisma.sql`(e.firstName LIKE ${pattern} OR e.lastName LIKE ${pattern} OR e.email LIKE ${pattern})`);
        }

        if (filter.orderState === 'order') {
            conditions.push(Prisma.sql`(t.projectId IS NOT NULL OR t.sourceStatus IN (${Prisma.join(ORDER_SOURCE_VALUES)}))`);
        } else if (filter.orderState === 'draft') {
            // NULL sourceStatus üç değerli mantıkta NOT IN ile elenirdi; açık
            // NULL dalı taslakların düşmesini engeller.
            conditions.push(Prisma.sql`t.projectId IS NULL`);
            conditions.push(Prisma.sql`(t.sourceStatus IS NULL OR t.sourceStatus NOT IN (${Prisma.join(ORDER_SOURCE_VALUES)}))`);
        }

        if (filter.mailSent === 'yes') conditions.push(Prisma.sql`t.offerMailSentAt IS NOT NULL`);
        else if (filter.mailSent === 'no') conditions.push(Prisma.sql`t.offerMailSentAt IS NULL`);

        return Prisma.join(conditions, ' AND ');
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
    private async findLeanList(
        filter: ITenderFilter,
        orderBySql: Prisma.Sql,
        page?: number,
        pageSize?: number,
    ): Promise<{ items: TenderListRow[]; total: number }> {
        const whereSql = this.buildLeanWhere(filter);
        const limitSql = page && pageSize
            ? Prisma.sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
            : Prisma.empty;

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    t.id, t.tenderNumber, t.version, t.projectId, t.sourceStatus,
                    t.createdByEmployeeId, t.currency, t.createdAt, t.offerMailSentAt,
                    c.companyName AS customerName,
                    e.firstName AS creatorFirstName,
                    e.lastName AS creatorLastName,
                    e.email AS creatorEmail,
                    (SELECT COUNT(*) FROM Position p WHERE p.tenderId = t.id) AS positionCount,
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
                ? prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                    SELECT COUNT(*) AS total
                    FROM Tender t
                    LEFT JOIN Customer c ON c.id = t.customerId
                    LEFT JOIN Employee e ON e.id = t.createdByEmployeeId
                    WHERE ${whereSql}
                `)
                : Promise.resolve([{ total: 0 }]),
        ]);

        const items: TenderListRow[] = rows.map((row) => ({
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
            positionCount: Number(row.positionCount ?? 0),
            grandTotal: Number(row.grandTotal ?? 0),
        }));

        return { items, total: Number(countRows[0]?.total ?? 0) };
    }

    // Sayfadaki tekliflerin tutar/pozisyon sayısını TEK gruplu sorguda hesaplar.
    // Önceden her teklifin bütün pozisyonları (+ her biri için calculation satırı)
    // çekilip toplam JS'te reduce ediliyordu: yüzlerce pozisyonlu tekliflerde
    // sayfa başına binlerce satır. CASE ifadesi eski reduce mantığının birebir
    // karşılığı — birim fiyat varsa iskontolu satır tutarı, yoksa hesaplanan fiyat.
    private async loadPositionTotals(tenderIds: string[]): Promise<Map<string, { positionCount: number; grandTotal: number }>> {
        const totals = new Map<string, { positionCount: number; grandTotal: number }>();
        if (tenderIds.length === 0) return totals;

        const rows = await prisma.$queryRaw<PositionTotalsRow[]>(Prisma.sql`
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
            WHERE p.tenderId IN (${Prisma.join(tenderIds)})
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

    private mapToEntity(data: any): Tender {
        return new Tender(
            data.id, data.tenantId, data.customerId, data.tenderNumber,
            data.version, data.format, data.status, data.createdByEmployeeId,
            data.createdAt, data.projectId, data.validUntil,
            data.offerMailSentAt, data.offerAcceptedAt, data.offerMailRecipient, data.offerAcceptanceToken,
            data.sourceCreatedAt, data.orderDate, data.billingAddress, data.deliveryAddress,
            data.internalDeliveryDate, data.priceList, data.paymentTerms, data.commissionNumber,
            data.salespersonName, data.sourceStatus, data.sourceCompany, data.shippingTerms,
            data.shippingWeight, data.fiscalPosition, data.salesTeam, data.onlineSignature,
            data.onlinePayment, data.coverLetter, data.closingNote, data.closingImages,
            data.sourceTotal, data.sourceNetAmount,
            data.sourceTaxAmount, data.sourceRecurringTotal, data.sourceMargin,
            data.billingSameAsInstallation,
            data.installationAddress,
            data.directDiscount,
            data.currency,
            data.directDiscountLabel,
            data.extraDiscount,
            data.extraDiscountLabel,
            data.totalDiscounts,
            data.paymentStages,
            data.customerReference,
            data.legacyNumber
        );
    }

    async create(tenderData: Partial<Tender>): Promise<Tender> {
        const data = await prisma.tender.create({
            data: tenderData as any
        });
        return this.mapToEntity(data);
    }

    async findById(
        id: string,
        tenantId: string,
        options?: { includePdfContent?: boolean }
    ): Promise<Tender | null> {
        // Scoped by both id and tenantId (findFirst, since the composite is not a
        // unique key). Cross-tenant ids simply resolve to null.
        const data = await prisma.tender.findFirst({
            where: { id, tenantId },
            select: {
                ...(options?.includePdfContent === false
                    ? TENDER_WITHOUT_PDF_CONTENT_SELECT
                    : TENDER_FULL_SELECT),
                customer: { select: TENDER_DETAIL_CUSTOMER_SELECT },
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                // Teklifin siparişi (1:1). Teklif ekranındaki ana düğme buna
                // bakar: sipariş varsa "Zum Auftrag" olur ve siparişi DOĞRUDAN
                // açar — sipariş otomatik üretildiği için ikinci bir "sipariş
                // oluştur" denemesi anlamsızdır.
                salesOrder: { select: { id: true, orderNumber: true, projectId: true } },
            },
        });
        if (!data) return null;
        const entity: any = this.mapToEntity(data);
        entity.salesOrder = (data as any).salesOrder ?? null;
        entity.pdfContentDeferred = options?.includePdfContent === false;
        entity.customerName = (data as any).customer?.companyName ?? null;
        // The customer's primary address (street / postal + city / country) formatted
        // as a single multi-line string — the default for the tender's address slot.
        entity.customerAddress = formatCustomerAddress((data as any).customer);
        entity.customerEmail = (data as any).customer?.mainEmail ?? null;
        entity.customerPhone = (data as any).customer?.mainPhone ?? null;
        entity.customerTaxNumber = (data as any).customer?.taxNumber ?? null;
        entity.createdByName = (data as any).createdBy
            ? `${(data as any).createdBy.firstName} ${(data as any).createdBy.lastName}`
            : null;
        entity.createdByEmail = (data as any).createdBy?.email ?? null;
        return entity;
    }

    async findAll(
        filter: ITenderFilter
    ): Promise<TenderListItem[] | { items: TenderListItem[]; total: number; page: number; pageSize: number; totalPages: number } | TenderListRow[] | { items: TenderListRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
        const where: any = { tenantId: filter.tenantId };
        if (filter.customerId) where.customerId = filter.customerId;
        if (filter.status) where.status = filter.status;
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
        const andConditions: any[] = [];
        if (filter.orderState === 'order') {
            andConditions.push({
                OR: [
                    { projectId: { not: null } },
                    { sourceStatus: { in: ORDER_SOURCE_VALUES } },
                ],
            });
        } else if (filter.orderState === 'draft') {
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
        if (andConditions.length > 0) where.AND = andConditions;

        if (filter.mailSent === 'yes') where.offerMailSentAt = { not: null };
        else if (filter.mailSent === 'no') where.offerMailSentAt = null;

        // Sıralama — yalnızca DB kolonlarına (hesaplanan grandTotal hariç) izin ver.
        const sortDir: 'asc' | 'desc' = filter.sortDirection === 'asc' ? 'asc' : 'desc';
        let orderBy: any = { createdAt: 'desc' };
        // Ham SQL yolunun karşılığı. Kolon adları SABİT literaller (kullanıcı
        // girdisi yalnızca yukarıdaki switch'ten geçen sabit bir anahtar).
        let orderBySql: Prisma.Sql = Prisma.sql`ORDER BY t.createdAt DESC`;
        const dirSql = sortDir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
        switch (filter.sortBy) {
            case 'tenderNumber':
                orderBy = { tenderNumber: sortDir };
                orderBySql = Prisma.sql`ORDER BY t.tenderNumber ${dirSql}`;
                break;
            case 'status':
                orderBy = { status: sortDir };
                orderBySql = Prisma.sql`ORDER BY t.status ${dirSql}`;
                break;
            case 'customerName':
                orderBy = { customer: { companyName: sortDir } };
                orderBySql = Prisma.sql`ORDER BY c.companyName ${dirSql}`;
                break;
            case 'createdAt':
                orderBy = { createdAt: sortDir };
                orderBySql = Prisma.sql`ORDER BY t.createdAt ${dirSql}`;
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
            (prisma as any).tender.findMany({
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
            page && pageSize ? prisma.tender.count({ where }) : Promise.resolve(0),
        ]);

        // Tutarlar sayfadaki teklifler için tek gruplu sorguda gelir.
        const positionTotals = await this.loadPositionTotals(data.map((d: any) => d.id));

        const items = data.map((d: any) => {
            const totals = positionTotals.get(d.id);
            const customerName = d.customer?.companyName ?? null;
            const createdByName = d.createdBy
                ? `${d.createdBy.firstName} ${d.createdBy.lastName}`.trim()
                : null;
            const createdByEmail = d.createdBy?.email ?? null;

            const item: any = this.mapToEntity(d);
            item.customerName = customerName;
            item.createdByName = createdByName;
            item.createdByEmail = createdByEmail;
            item.positionCount = totals?.positionCount ?? 0;
            item.grandTotal = totals?.grandTotal ?? 0;
            return item as TenderListItem;
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

    async delete(id: string, tenantId: string): Promise<void> {
        await prisma.$transaction(async (tx) => {
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
            await tx.tender.delete({ where: { id } });
        });
    }

    async updateStatus(id: string, status: 'Draft' | 'Approved' | 'Exported', tenantId: string): Promise<Tender> {
        // Update only the row matching id + tenantId; if nothing matched the
        // tender either doesn't exist or belongs to another tenant.
        const result = await prisma.tender.updateMany({
            where: { id, tenantId },
            data: { status }
        });
        if (result.count === 0) {
            throw new Error("Teklif bulunamadı veya bu şirkete ait değil.");
        }
        const data = await prisma.tender.findUniqueOrThrow({ where: { id } });
        return this.mapToEntity(data);
    }

    async createNextVersion(tenderId: string, newCreatedBy: string, tenantId: string): Promise<Tender> {
        const existingTender = await prisma.tender.findFirst({
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

        if (!existingTender) throw new Error("Kopyalanacak teklif bulunamadı.");

        const newTenderId = nanoid(10);
        const newVersion = existingTender.version + 1;

        const result = await prisma.$transaction(async (tx) => {
            const createdTender = await tx.tender.create({
                data: {
                    id: newTenderId,
                    tenantId: existingTender.tenantId,
                    customerId: existingTender.customerId,
                    tenderNumber: existingTender.tenderNumber,
                    version: newVersion,
                    format: existingTender.format,
                    status: 'Draft',
                    createdByEmployeeId: newCreatedBy,
                    validUntil: existingTender.validUntil,
                    sourceCreatedAt: (existingTender as any).sourceCreatedAt,
                    orderDate: (existingTender as any).orderDate,
                    billingAddress: (existingTender as any).billingAddress,
                    installationAddress: (existingTender as any).installationAddress,
                    deliveryAddress: (existingTender as any).deliveryAddress,
                    billingSameAsInstallation: (existingTender as any).billingSameAsInstallation,
                    directDiscount: (existingTender as any).directDiscount,
                    directDiscountLabel: (existingTender as any).directDiscountLabel,
                    extraDiscount: (existingTender as any).extraDiscount,
                    extraDiscountLabel: (existingTender as any).extraDiscountLabel,
                    totalDiscounts: (existingTender as any).totalDiscounts,
                    paymentStages: (existingTender as any).paymentStages,
                    internalDeliveryDate: (existingTender as any).internalDeliveryDate,
                    priceList: (existingTender as any).priceList,
                    paymentTerms: (existingTender as any).paymentTerms,
                    commissionNumber: (existingTender as any).commissionNumber,
                    customerReference: (existingTender as any).customerReference,
                    currency: (existingTender as any).currency,
                    salespersonName: (existingTender as any).salespersonName,
                    sourceStatus: (existingTender as any).sourceStatus,
                    sourceCompany: (existingTender as any).sourceCompany,
                    shippingTerms: (existingTender as any).shippingTerms,
                    shippingWeight: (existingTender as any).shippingWeight,
                    fiscalPosition: (existingTender as any).fiscalPosition,
                    salesTeam: (existingTender as any).salesTeam,
                    onlineSignature: (existingTender as any).onlineSignature,
                    onlinePayment: (existingTender as any).onlinePayment,
                    coverLetter: (existingTender as any).coverLetter,
                    closingNote: (existingTender as any).closingNote,
                    closingImages: (existingTender as any).closingImages,
                    sourceTotal: (existingTender as any).sourceTotal,
                    sourceNetAmount: (existingTender as any).sourceNetAmount,
                    sourceTaxAmount: (existingTender as any).sourceTaxAmount,
                    sourceRecurringTotal: (existingTender as any).sourceRecurringTotal,
                    sourceMargin: (existingTender as any).sourceMargin,
                    projectId: existingTender.projectId,
                }
            });

            const idMapping = new Map<string, string>(); 

            for (const pos of existingTender.positions) {
                const newPosId = nanoid(10);
                idMapping.set(pos.id, newPosId);
            }

            for (const pos of existingTender.positions) {
                const newPosId = idMapping.get(pos.id)!;
                const newParentId = pos.parentPositionId ? idMapping.get(pos.parentPositionId) || null : null;

                await tx.position.create({
                    data: {
                        id: newPosId,
                        tenantId: pos.tenantId,
                        tenderId: newTenderId,
                        parentPositionId: newParentId,
                        rowType: (pos as any).rowType || 'SECTION',
                        sourceArticleId: (pos as any).sourceArticleId || null,
                        displayOrder: (pos as any).displayOrder ?? 0,
                        npkCode: pos.npkCode || null,
                        positionNumber: pos.positionNumber,
                        shortDescription: pos.shortDescription,
                        longDescription: pos.longDescription || null,
                        quantity: pos.quantity,
                        unit: pos.unit || null,
                        hierarchyLevel: pos.hierarchyLevel,
                        unitPrice: pos.unitPrice,
                        discount: pos.discount,
                        discounts: (pos as any).discounts,
                        taxRate: pos.taxRate,
                        imageUrl: pos.imageUrl,
                    }
                });

                if (pos.calculation) {
                    await tx.calculationItem.create({
                        data: {
                            id: nanoid(8),
                            positionId: newPosId,
                            materialCost: pos.calculation.materialCost,
                            laborCost: pos.calculation.laborCost,
                            overheadCost: pos.calculation.overheadCost,
                            riskAmount: pos.calculation.riskAmount,
                            additionalCost: (pos.calculation as any).additionalCost || 0,
                            profitMargin: pos.calculation.profitMargin,
                            totalCalculatedPrice: pos.calculation.totalCalculatedPrice
                        }
                    });
                }

                if (pos.articleMappings && pos.articleMappings.length > 0) {
                    for (const mapping of pos.articleMappings) {
                        await tx.positionArticleMapping.create({
                            data: {
                                id: nanoid(10),
                                positionId: newPosId,
                                articleId: mapping.articleId,
                                quantityMultiplier: mapping.quantityMultiplier,
                                discount: (mapping as any).discount ?? 0,
                            }
                        });
                    }
                }
            }

            return createdTender;
        });

        return this.mapToEntity(result);
    }
}
