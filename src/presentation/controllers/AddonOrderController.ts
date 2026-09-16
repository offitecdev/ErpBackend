import { normalizeAddonLines as normalizeLines, priceAddonProduct, readAddonLineMetadata, signedAfterDiscounts } from '../../application/utils/addonDocumentLines';
import { checkMinderungAgainstBilled, loadMinderungCapacity } from '../../shared/minderung';
import { orderTotal } from './salesOrder.pricing';
import { MAX_TOTAL_DISCOUNTS, normalizeDiscountList, parseDiscountList } from './tender.discounts';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { bookConsumption } from '../../shared/articleStock';
import { nextDocumentNumber } from '../../shared/documentNumber';
import { normalizePaymentStages, serializePaymentStages, validatePaymentStages } from '../../application/utils/paymentSchedule';
import { listBillingFigures, summariesFromInvoices } from './SalesOrderController';

/**
 * ── NACHTRÄGE (Zusatzaufträge, NT-…) ─────────────────────────────────────────
 *
 * Ein Nachtrag ist eine `SalesOrder` mit `parentSalesOrderId` und dem Code
 * `NT-JJJJ-NNNNN` (siehe shared/documentNumber.ts). Bisher entstand er NUR aus
 * dem Feld: die seit dem letzten Nachtrag aufgelaufenen Spesen, Zusatzmaterialien
 * und Überzeiten des Hauptauftrags wurden zusammengezogen
 * (`ProjectController.createAddonOrder` / `createAddonOrderForParent`).
 *
 * Dieser Controller (05.09.2026, Vorgabe Samet) fügt drei Dinge hinzu, die dem
 * Nachtrag als EIGENEM Beleg fehlten:
 *
 *   1. `GET /addon-orders`            — ALLE Nachträge des Mandanten in einer
 *                                        Liste (die Seite «Zusatzaufträge» unter
 *                                        Verkauf, neben den Aufträgen/AB), oder
 *                                        die eines Hauptauftrags / Projekts.
 *   2. `GET /addon-orders/:id/document` — alles, was das Nachtrags-PDF braucht,
 *                                        aus der Id allein: Kopf, Kunde, Auftrag,
 *                                        Projekt und die Positionen des Nachtrags.
 *   3. `POST /addon-orders` + `PUT /addon-orders/:id/lines` — der FREIE
 *                                        Nachtrag: eigener NT-Code, Positionen
 *                                        (Produkte/Material aus dem Katalog und
 *                                        freie Textzeilen) direkt eingetragen.
 *
 * ── Woraus ein Nachtrag besteht ──
 * Seine Positionen SIND die bestehenden Projektkostensätze, mit der Id des
 * Nachtrags gestempelt (`salesOrderId`): `ProjectExtraMaterial` (Artikel ×
 * Menge × Preis), `ProjectExpense` (freie Zeile mit Betrag) und — nur aus dem
 * Feld — `ProjectReport` (Überzeit). Ein freier Nachtrag legt seine Zeilen als
 * genau diese Sätze an. Dadurch lesen Kostenübersicht, Rechnung, Löschen
 * (Rückbuchung ins Lager) und Projektsummen einen freien Nachtrag OHNE eine
 * einzige Änderung genauso wie einen aus dem Feld.
 *
 * Nachträge, die VOR dem 07.08.2026 entstanden, tragen ihre Sätze noch am
 * Hauptauftrag; sie werden über das Zeitfenster (vorheriger Nachtrag → dieser)
 * gefunden — dieselbe Regel wie `scopedRecords` im Frontend. Sie wird hier
 * beim Dokument nachgebaut, damit das PDF auch für sie stimmt.
 */

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Rechte, mit denen jemand Nachträge SEHEN darf — Büro wie Monteur. */
export const ADDON_READ_PERMISSIONS = [
    'crm.customers.view', 'billing.view', 'tenders.view',
    'projects.view', 'projects.report', 'maintenance.tasks.manage',
];

const parseOrderDate = (raw: unknown): Date | null | undefined => {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const parsed = new Date(String(raw));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Der ZAHLUNGSPLAN des Nachtrags (Vorgabe 05.09.2026). Er wohnt in derselben
 * Spalte wie der des Hauptauftrags (`SalesOrder.paymentStages`) und gehorcht
 * denselben Regeln — Raten mit Fälligkeit, zusammen 100%. Ein leerer Plan ist
 * erlaubt und heisst «frei».
 *
 * Rückgabe: `undefined` = nicht mitgeschickt (unverändert lassen),
 * `{ value }` = so speichern (null löscht ihn), `{ error }` = abweisen.
 */
const parsePaymentStagesInput = (raw: unknown): { value?: string | null; error?: string } | undefined => {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return { value: null };
    const stages = normalizePaymentStages(raw);
    if (!stages) return { error: 'Ödeme planı geçersiz.' };
    const stageError = validatePaymentStages(stages);
    if (stageError) return { error: stageError };
    return { value: serializePaymentStages(stages) };
};

/**
 * MINDERUNG PRUEFEN (16.09.2026) — zwei Schranken, beide mit Kennung fuer die
 * Oberflaeche:
 *   • je Artikel faellt hoechstens weg, was im Auftrag steht
 *     (Offertpositionen + Zusatzmaterial − andere Minderungen);
 *   • die Summe darf den Hauptauftrag nicht unter das bereits Verrechnete
 *     druecken — dafuer braucht es eine Gutschrift.
 */
const validateMinderung = async (opts: {
    tenantId: string;
    parent: { id: string; tenderId?: string | null };
    addonId: string | null;
    products: Array<{ articleId: string; quantity: number }>;
    nextTotal: number;
    articleName: (articleId: string) => string;
}): Promise<{ error: string; code: string; params?: Record<string, string | number> } | null> => {
    const { tenantId, parent, addonId, products, nextTotal, articleName } = opts;
    const minusByArticle = new Map<string, number>();
    for (const line of products) {
        if (line.quantity < 0) minusByArticle.set(line.articleId, (minusByArticle.get(line.articleId) ?? 0) - line.quantity);
    }
    if (minusByArticle.size) {
        const capacity = await loadMinderungCapacity(prisma as any, { tenantId, parent, excludeAddonId: addonId });
        for (const [articleId, removed] of minusByArticle) {
            const available = Math.max(0, capacity.get(articleId) ?? 0);
            if (available <= 0) {
                return {
                    error: `${articleName(articleId)} steht nicht im Auftrag und kann nicht gemindert werden.`,
                    code: 'MINDERUNG_ARTICLE_NOT_IN_ORDER',
                    params: { article: articleName(articleId) },
                };
            }
            if (removed > available + 0.0001) {
                return {
                    error: `${articleName(articleId)}: hoechstens ${available} koennen wegfallen.`,
                    code: 'MINDERUNG_QUANTITY_TOO_HIGH',
                    params: { article: articleName(articleId), available },
                };
            }
        }
    }
    if (nextTotal < 0) {
        const violation = await checkMinderungAgainstBilled(prisma as any, {
            tenantId,
            parentSalesOrderId: parent.id,
            addonId,
            nextAddonTotal: nextTotal,
        });
        if (violation) {
            return {
                error: `Die Minderung wuerde den Auftrag unter den bereits verrechneten Betrag druecken (verrechnet ${violation.billed.toFixed(2)}, neu ${violation.base.toFixed(2)}). Dafuer ist eine Gutschrift noetig.`,
                code: 'MINDERUNG_BELOW_BILLED',
                params: { billed: violation.billed.toFixed(2), base: violation.base.toFixed(2) },
            };
        }
    }
    return null;
};

export class AddonOrderController {
    /**
     * Liste der Nachträge. Ohne Filter: alle des Mandanten (Seite
     * «Zusatzaufträge»); `parentSalesOrderId` = die eines Hauptauftrags (das
     * Fenster aus dem Rapport); `projectId` = die eines Projekts.
     *
     * EINE Abfrage mit JOINs statt Prisma-`include` (jede Relation wäre eine
     * eigene Runde zur entfernten Datenbank), die Rechnungen laufen PARALLEL.
     */
    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const conditions: Prisma.Sql[] = [
                Prisma.sql`so.tenantId = ${tenantId}`,
                Prisma.sql`so.parentSalesOrderId IS NOT NULL`,
            ];
            if (req.query.parentSalesOrderId) {
                conditions.push(Prisma.sql`so.parentSalesOrderId = ${String(req.query.parentSalesOrderId)}`);
            }
            if (req.query.projectId) {
                conditions.push(Prisma.sql`so.projectId = ${String(req.query.projectId)}`);
            }
            if (req.query.customerId) {
                conditions.push(Prisma.sql`so.customerId = ${String(req.query.customerId)}`);
            }
            if (req.query.search) {
                const pattern = `%${String(req.query.search)}%`;
                conditions.push(Prisma.sql`(
                    so.orderNumber LIKE ${pattern}
                    OR so.legacyNumber LIKE ${pattern}
                    OR parent.orderNumber LIKE ${pattern}
                    OR c.companyName LIKE ${pattern}
                    OR p.projectNumber LIKE ${pattern}
                    OR p.projectName LIKE ${pattern}
                )`);
            }

            const rowsPromise = prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    so.id, so.orderNumber, so.legacyNumber, so.revisionNumber, so.orderType, so.status,
                    so.cancelledAt, so.cancelReason,
                    so.totalAmount, so.paymentStages, so.createdAt, so.orderDate,
                    so.parentSalesOrderId, so.projectId, so.customerId,
                    parent.orderNumber AS parentOrderNumber,
                    parent.orderType AS parentOrderType,
                    parent.tenderId AS parentTenderId,
                    c.companyName AS customerCompanyName,
                    p.projectNumber AS projectNumber,
                    p.projectName AS projectName,
                    e.firstName AS creatorFirstName,
                    e.lastName AS creatorLastName
                FROM SalesOrder so
                LEFT JOIN SalesOrder parent ON parent.id = so.parentSalesOrderId
                LEFT JOIN Customer c ON c.id = so.customerId
                LEFT JOIN Project p ON p.id = so.projectId
                LEFT JOIN Employee e ON e.id = so.createdByEmployeeId
                WHERE ${Prisma.join(conditions, ' AND ')}
                ORDER BY so.createdAt DESC
            `);
            // Rechnungen ALLER Nachträge des Mandanten, die zur Bedingung passen
            // — dieselbe Bedingung als Unterabfrage, damit beide Runden parallel
            // laufen (wie `myOrders`).
            const invoicesPromise = prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT i.id, i.salesOrderId, i.invoiceNumber, i.billingType, i.kind, i.billedPercent, i.amount, i.status, i.createdAt
                FROM Invoice i
                WHERE i.tenantId = ${tenantId}
                  AND i.salesOrderId IN (
                    SELECT so.id
                    FROM SalesOrder so
                    LEFT JOIN SalesOrder parent ON parent.id = so.parentSalesOrderId
                    LEFT JOIN Customer c ON c.id = so.customerId
                    LEFT JOIN Project p ON p.id = so.projectId
                    WHERE ${Prisma.join(conditions, ' AND ')}
                  )
                ORDER BY i.createdAt DESC
            `);
            const [rows, invoiceRows] = await Promise.all([rowsPromise, invoicesPromise]);

            const summaries = summariesFromInvoices(
                // Eine Minderung (Minussumme) wird nicht selbst verrechnet: Grundlage 0.
                rows.map((row) => ({ salesOrderId: row.id, baseAmount: Math.max(0, Number(row.totalAmount || 0)), paymentStages: row.paymentStages ?? null })),
                invoiceRows.map((row) => ({ ...row, billedPercent: Number(row.billedPercent || 0), amount: Number(row.amount || 0) })),
            );

            res.status(200).json(rows.map((row) => ({
                id: row.id,
                orderNumber: row.orderNumber,
                legacyNumber: row.legacyNumber ?? null,
                revisionNumber: row.revisionNumber ?? null,
                orderType: row.orderType,
                status: row.status,
                cancelledAt: row.cancelledAt ?? null,
                cancelReason: row.cancelReason ?? null,
                totalAmount: Number(row.totalAmount || 0),
                createdAt: row.createdAt,
                orderDate: row.orderDate ?? null,
                parentSalesOrderId: row.parentSalesOrderId,
                parentSalesOrder: row.parentSalesOrderId
                    ? { id: row.parentSalesOrderId, orderNumber: row.parentOrderNumber, orderType: row.parentOrderType ?? null, tenderId: row.parentTenderId ?? null }
                    : null,
                projectId: row.projectId ?? null,
                project: row.projectId
                    ? { id: row.projectId, projectNumber: row.projectNumber ?? null, projectName: row.projectName }
                    : null,
                customerId: row.customerId ?? null,
                customer: row.customerId ? { id: row.customerId, companyName: row.customerCompanyName } : null,
                createdBy: row.creatorFirstName || row.creatorLastName
                    ? { firstName: row.creatorFirstName, lastName: row.creatorLastName }
                    : null,
                billingSummary: listBillingFigures(summaries.get(row.id)),
            })));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Die Positionen eines Nachtrags: direkt gestempelte Sätze PLUS — für
     * Nachträge von vor dem 07.08.2026 — die am Hauptauftrag verbliebenen Sätze
     * im Zeitfenster (vorheriger Nachtrag → dieser). Beide Mengen sind disjunkt
     * (andere salesOrderId), darum einfach zusammengelegt.
     */
    private async loadAddonLines(addon: any) {
        const projectId = addon.projectId as string | null;
        const parentId = addon.parentSalesOrderId as string;
        const siblings: any[] = await (prisma as any).salesOrder.findMany({
            where: { parentSalesOrderId: parentId, tenantId: addon.tenantId, NOT: { id: addon.id } },
            select: { id: true, createdAt: true },
        });
        const previous = siblings
            .filter((sibling) => new Date(sibling.createdAt).getTime() < new Date(addon.createdAt).getTime())
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;
        const windowOf = (dateField: string) => ({
            salesOrderId: parentId,
            [dateField]: {
                ...(previous ? { gt: previous.createdAt } : {}),
                lte: addon.createdAt,
            },
        });
        const scope = projectId ? { projectId } : {};

        const [materials, expenses, reports] = await Promise.all([
            (prisma as any).projectExtraMaterial.findMany({
                where: { ...scope, OR: [{ salesOrderId: addon.id }, windowOf('addedAt')] },
                orderBy: { addedAt: 'asc' },
                select: {
                    id: true, quantity: true, unitPrice: true, description: true, addedAt: true, salesOrderId: true,
                    article: { select: { id: true, name: true, articleCode: true, unit: true, salePrice: true } },
                },
            }),
            (prisma as any).projectExpense.findMany({
                where: { ...scope, OR: [{ salesOrderId: addon.id }, windowOf('expenseDate')] },
                orderBy: { expenseDate: 'asc' },
                select: { id: true, expenseType: true, amount: true, description: true, expenseDate: true, salesOrderId: true },
            }),
            (prisma as any).projectReport.findMany({
                where: { ...scope, OR: [{ salesOrderId: addon.id }, windowOf('reportDate')] },
                orderBy: { workDate: 'asc' },
                select: {
                    id: true, workDate: true, reportDate: true, overtimeMinutes: true, overtimeHourlyRate: true, overtimeCost: true,
                    operationsDone: true, salesOrderId: true,
                    employee: { select: { id: true, firstName: true, lastName: true } },
                },
            }),
        ]);

        return {
            materials: materials.map((row: any) => ({
                id: row.id,
                quantity: Number(row.quantity || 0),
                unitPrice: Number(row.unitPrice || 0),
                description: row.description ?? null,
                documentLine: readAddonLineMetadata(row.documentLine),
                addedAt: row.addedAt,
                // Ob die Zeile dem Nachtrag SELBST gehört (bearbeitbar) oder
                // über das Zeitfenster geerbt ist.
                own: row.salesOrderId === addon.id,
                article: row.article
                    ? { id: row.article.id, name: row.article.name, articleCode: row.article.articleCode, unit: row.article.unit ?? null, salePrice: Number(row.article.salePrice || 0) }
                    : null,
            })),
            expenses: expenses.map((row: any) => ({
                id: row.id,
                expenseType: row.expenseType,
                amount: Number(row.amount || 0),
                description: row.description ?? null,
                documentLine: readAddonLineMetadata(row.documentLine),
                expenseDate: row.expenseDate,
                own: row.salesOrderId === addon.id,
            })),
            overtime: reports
                .filter((row: any) => Number(row.overtimeCost || 0) > 0)
                .map((row: any) => ({
                    id: row.id,
                    workDate: row.workDate,
                    reportDate: row.reportDate,
                    own: row.salesOrderId === addon.id,
                    overtimeMinutes: Number(row.overtimeMinutes || 0),
                    overtimeHourlyRate: Number(row.overtimeHourlyRate || 0),
                    overtimeCost: Number(row.overtimeCost || 0),
                    operationsDone: row.operationsDone ?? null,
                    employee: row.employee ?? null,
                })),
        };
    }

    /**
     * Das Nachtrags-DOKUMENT aus der Id allein — Kopf, Kunde, Hauptauftrag,
     * Projekt, Offerte (Kommission, Adressen, Verkäufer) und die Positionen.
     * Das PDF wird im Browser gesetzt (utils/pdf/addonOrderPdf.ts); dieser
     * Endpunkt liefert nur die Daten, in EINER Antwort, damit jede Fläche —
     * Auftrag, Projekt, Liste, Rapport — dasselbe Dokument bauen kann.
     */
    async document(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const addon: any = await (prisma as any).salesOrder.findFirst({
                where: { id, tenantId, parentSalesOrderId: { not: null } },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    project: { select: { id: true, projectNumber: true, projectName: true } },
                    parentSalesOrder: {
                        select: {
                            id: true, orderNumber: true, orderDate: true, createdAt: true, tenderId: true,
                            tender: {
                                select: {
                                    id: true, tenderNumber: true, commissionNumber: true, customerReference: true,
                                    salespersonName: true, currency: true,
                                    billingAddress: true, installationAddress: true, deliveryAddress: true,
                                    createdBy: { select: { firstName: true, lastName: true } },
                                },
                            },
                        },
                    },
                    createdBy: { select: { id: true, firstName: true, lastName: true } },
                },
            });
            if (!addon) return res.status(404).json({ error: 'Zusatzauftrag nicht gefunden.' });

            const lines = await this.loadAddonLines(addon);
            const invoiceCount = await (prisma as any).invoice.count({ where: { salesOrderId: addon.id, tenantId } });
            const tender = addon.parentSalesOrder?.tender ?? null;

            res.status(200).json({
                id: addon.id,
                orderNumber: addon.orderNumber,
                legacyNumber: addon.legacyNumber ?? null,
                revisionNumber: addon.revisionNumber ?? null,
                status: addon.status,
                totalAmount: Number(addon.totalAmount || 0),
                orderDate: addon.orderDate ?? null,
                createdAt: addon.createdAt,
                // Zahlungsplan des Nachtrags (JSON-Ratenliste) — dieselbe Spalte
                // und dieselbe Lesart wie beim Hauptauftrag.
                paymentStages: addon.paymentStages ?? null,
                // Einleitungstext des Belegs — derselbe Slot wie bei der
                // Auftragsbestätigung; NULL = Standardsatz der Vorlage.
                confirmationNote: addon.confirmationNote ?? null,
                addonDiscounts: addon.addonDiscounts ?? null,
                invoiced: invoiceCount > 0,
                parentSalesOrder: addon.parentSalesOrder
                    ? { id: addon.parentSalesOrder.id, orderNumber: addon.parentSalesOrder.orderNumber, orderDate: addon.parentSalesOrder.orderDate ?? null, createdAt: addon.parentSalesOrder.createdAt, tenderId: addon.parentSalesOrder.tenderId ?? null }
                    : null,
                project: addon.project ?? null,
                customer: addon.customer ?? null,
                tender: tender
                    ? {
                        id: tender.id,
                        tenderNumber: tender.tenderNumber,
                        commissionNumber: tender.commissionNumber ?? null,
                        customerReference: tender.customerReference ?? null,
                        currency: tender.currency ?? null,
                        salespersonName: tender.salespersonName
                            || [tender.createdBy?.firstName, tender.createdBy?.lastName].filter(Boolean).join(' ')
                            || null,
                        billingAddress: tender.billingAddress ?? null,
                        installationAddress: tender.installationAddress ?? null,
                        deliveryAddress: tender.deliveryAddress ?? null,
                    }
                    : null,
                createdBy: addon.createdBy ?? null,
                lines,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * FREIER NACHTRAG: eigener NT-Code, Positionen direkt eingetragen.
     *
     * Körper: `{ parentSalesOrderId, orderDate?, note?, lines: [...] }`. Der
     * Hauptauftrag muss ein Projekt tragen — die Zeilen werden als
     * Projektkostensätze angelegt und die brauchen ein Projekt (ein
     * Lieferauftrag ohne Projekt kennt darum keine Nachträge, wie bisher).
     * Produktzeilen buchen ihre Menge aus dem Lager (dieselbe Buchhaltung wie
     * das Zusatzmaterial des Rapports; Löschen bucht zurück).
     */
    /**
     * MINDERUNG — WAS KANN WEGFALLEN? (16.09.2026)
     *
     * Die Artikel des Hauptauftrags mit dem Preis, zu dem sie verkauft wurden,
     * und zwar so, wie der Auftrag rechnet: Zeilenrabatt, MWST und die
     * Belegrabatte der Offerte eingerechnet (`orderTotal` für EINE Einheit) —
     * Nachtragszeilen sind brutto wie die Auftragssumme. Ohne Offertposition
     * gilt der Preis des Zusatzmaterials. Dazu die
     * Menge, die noch wegfallen kann. Die Maske legt daraus eine Minuszeile an —
     * so trägt die Minderung denselben Preis wie der Auftrag, nicht den
     * heutigen Katalogpreis.
     */
    async minderungSources(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const rawParentId = String(req.query.parentSalesOrderId || '').trim();
            const excludeAddonId = String(req.query.excludeAddonId || '').trim() || null;
            if (!rawParentId) return res.status(400).json({ error: 'Hauptauftrag fehlt.' });
            const selected: any = await (prisma as any).salesOrder.findFirst({
                where: { id: rawParentId, tenantId },
                select: { id: true, tenderId: true, parentSalesOrderId: true },
            });
            if (!selected) return res.status(404).json({ error: 'Hauptauftrag nicht gefunden.' });
            const parent: any = selected.parentSalesOrderId
                ? await (prisma as any).salesOrder.findFirst({
                    where: { id: selected.parentSalesOrderId, tenantId },
                    select: { id: true, tenderId: true },
                })
                : selected;
            if (!parent) return res.status(404).json({ error: 'Hauptauftrag nicht gefunden.' });

            const [capacity, positions, tender] = await Promise.all([
                loadMinderungCapacity(prisma as any, { tenantId, parent, excludeAddonId }),
                parent.tenderId
                    ? (prisma as any).position.findMany({
                        where: { tenderId: parent.tenderId, tenantId, sourceArticleId: { not: null } },
                        orderBy: { displayOrder: 'asc' },
                        select: { sourceArticleId: true, shortDescription: true, unit: true, unitPrice: true, discount: true, taxRate: true },
                    })
                    : Promise.resolve([]),
                parent.tenderId
                    ? (prisma as any).tender.findFirst({
                        where: { id: parent.tenderId, tenantId },
                        select: { directDiscount: true, extraDiscount: true },
                    })
                    : Promise.resolve(null),
            ]);
            const articleIds = [...capacity.keys()];
            const articles: any[] = articleIds.length
                ? await (prisma as any).article.findMany({
                    where: { id: { in: articleIds }, tenantId },
                    select: { id: true, name: true, unit: true, salePrice: true },
                })
                : [];
            const extras: any[] = articleIds.length
                ? await (prisma as any).projectExtraMaterial.findMany({
                    where: { articleId: { in: articleIds }, salesOrderId: parent.id, quantity: { gt: 0 } },
                    select: { articleId: true, unitPrice: true },
                })
                : [];
            const articleById = new Map<string, any>(articles.map((row) => [row.id, row]));
            const positionByArticle = new Map<string, any>();
            for (const row of positions as any[]) {
                if (!positionByArticle.has(row.sourceArticleId)) positionByArticle.set(row.sourceArticleId, row);
            }
            const extraPriceByArticle = new Map<string, number>();
            for (const row of extras) {
                if (!extraPriceByArticle.has(row.articleId)) extraPriceByArticle.set(row.articleId, Number(row.unitPrice || 0));
            }

            const items = articleIds
                .map((articleId) => {
                    const available = round2(Math.max(0, capacity.get(articleId) ?? 0));
                    const position = positionByArticle.get(articleId);
                    const article = articleById.get(articleId);
                    const unitPrice = position && position.unitPrice != null
                        ? round2(orderTotal([{ ...position, quantity: 1 }], tender?.directDiscount, tender?.extraDiscount))
                        : extraPriceByArticle.get(articleId) ?? Number(article?.salePrice || 0);
                    return {
                        articleId,
                        description: position?.shortDescription || article?.name || '',
                        unit: position?.unit || article?.unit || '',
                        unitPrice,
                        available,
                    };
                })
                .filter((item) => item.available > 0);

            res.status(200).json({ parentSalesOrderId: parent.id, items });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async create(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const rawParentId = String(req.body?.parentSalesOrderId || '').trim();
            if (!rawParentId) return res.status(400).json({ error: 'Hauptauftrag fehlt.' });

            const selected: any = await (prisma as any).salesOrder.findFirst({ where: { id: rawParentId, tenantId } });
            if (!selected) return res.status(404).json({ error: 'Hauptauftrag nicht gefunden.' });
            // Wer einen Nachtrag anklickt, meint dessen Hauptauftrag.
            const parent: any = selected.parentSalesOrderId
                ? await (prisma as any).salesOrder.findFirst({ where: { id: selected.parentSalesOrderId, tenantId } })
                : selected;
            if (!parent) return res.status(404).json({ error: 'Hauptauftrag nicht gefunden.' });
            // Zu einem STORNIERTEN Auftrag entsteht kein Nachtrag mehr
            // (Vorgabe Samet 06.09.2026) — erst das Storno aufheben.
            if (parent.cancelledAt || parent.status === 'CANCELLED') {
                return res.status(400).json({ error: 'Zu einem stornierten Auftrag kann kein Nachtrag erstellt werden.' });
            }
            if (!parent.projectId) {
                return res.status(400).json({ error: 'Nachträge gibt es nur zu Aufträgen mit Projekt.' });
            }

            const { products, texts } = normalizeLines(req.body?.lines);
            if (products.length === 0 && texts.length === 0) {
                return res.status(400).json({ error: 'Mindestens eine Position ist nötig.' });
            }
            const orderDate = parseOrderDate(req.body?.orderDate);
            if (orderDate === undefined && req.body?.orderDate !== undefined) {
                return res.status(400).json({ error: 'Datum ungültig.' });
            }
            const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;
            const schedule = parsePaymentStagesInput(req.body?.paymentStages);
            if (schedule?.error) return res.status(400).json({ error: schedule.error });

            // Artikel des Mandanten — Name, Preis. Ein fremder oder gelöschter
            // Artikel fliegt heraus, statt still eine Zeile ohne Preis zu werden.
            const articleIds = [...new Set(products.map((line) => line.articleId))];
            const articles: any[] = articleIds.length
                ? await (prisma as any).article.findMany({
                    where: { id: { in: articleIds }, tenantId },
                    select: { id: true, name: true, salePrice: true },
                })
                : [];
            const articleById = new Map<string, any>(articles.map((article) => [article.id, article]));
            const missing = articleIds.find((articleId) => !articleById.has(articleId));
            if (missing) return res.status(400).json({ error: 'Ein Artikel wurde nicht gefunden.' });

            const siblings: any[] = await (prisma as any).salesOrder.findMany({
                where: { parentSalesOrderId: parent.id, tenantId },
                select: { revisionNumber: true },
            });
            const nextRevision = Math.max(0, ...siblings.map((row) => Number(row.revisionNumber || 0))) + 1;

            const priced = products.map((line) => priceAddonProduct(line, articleById.get(line.articleId)));
            const addonDiscounts = normalizeDiscountList(req.body?.discounts, MAX_TOTAL_DISCOUNTS);
            const subtotal = round2(
                priced.reduce((sum, line) => sum + line.lineTotal, 0)
                + texts.reduce((sum, line) => sum + line.amount, 0),
            );

            const totalAmount = round2(signedAfterDiscounts(subtotal, parseDiscountList(addonDiscounts, MAX_TOTAL_DISCOUNTS)));

            // MINDERUNG (16.09.2026): was wegfaellt, muss im Auftrag stehen, und
            // die Summe darf den Auftrag nicht unter das Verrechnete druecken.
            const minderungError = await validateMinderung({
                tenantId,
                parent,
                addonId: null,
                products: priced,
                nextTotal: totalAmount,
                articleName: (articleId) => articleById.get(articleId)?.name || articleId,
            });
            if (minderungError) return res.status(409).json(minderungError);

            const created = await (prisma as any).$transaction(async (tx: any) => {
                const orderNumber = await nextDocumentNumber(tenantId, 'ADDON', tx);
                const addon = await tx.salesOrder.create({
                    data: {
                        id: nanoid(10),
                        tenantId,
                        customerId: parent.customerId ?? null,
                        tenderId: null,
                        projectId: parent.projectId,
                        parentSalesOrderId: parent.id,
                        revisionNumber: nextRevision,
                        orderNumber,
                        orderType: 'PROJECT_ADDON',
                        status: 'ORDERED',
                        totalAmount,
                        orderDate: orderDate ?? new Date(),
                        confirmationNote: note,
                        addonDiscounts,
                        paymentStages: schedule?.value ?? null,
                        createdByEmployeeId: employeeId,
                    },
                    include: {
                        customer: { select: { id: true, companyName: true } },
                        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                    },
                });

                for (const line of priced) {
                    await tx.projectExtraMaterial.create({
                        data: {
                            id: nanoid(10),
                            projectId: parent.projectId,
                            salesOrderId: addon.id,
                            appointmentId: null,
                            articleId: line.articleId,
                            quantity: line.quantity,
                            unitPrice: line.unitPrice,
                            description: line.description,
                            documentLine: line.documentLine,
                            addedAt: addon.orderDate ?? new Date(),
                        },
                    });
                    await bookConsumption(tx, {
                        tenantId,
                        articleId: line.articleId,
                        employeeId,
                        quantity: line.quantity,
                        referenceId: addon.id,
                        description: `Nachtrag ${orderNumber}`,
                    });
                }
                for (const line of texts) {
                    await tx.projectExpense.create({
                        data: {
                            id: nanoid(10),
                            projectId: parent.projectId,
                            salesOrderId: addon.id,
                            appointmentId: null,
                            expenseType: line.description,
                            amount: line.amount,
                            description: line.longDescription ?? '',
                            documentLine: line.documentLine,
                            expenseDate: addon.orderDate ?? new Date(),
                        },
                    });
                }
                return addon;
            });

            res.status(201).json({ message: `${created.orderNumber} erstellt.`, salesOrder: created });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Positionen eines Nachtrags ERSETZEN (letzter Stand gilt — dieselbe Regel
     * wie beim Rapport): Zeilen mit Id werden angepasst, fehlende gelöscht (und
     * ihr Material zurückgebucht), Zeilen ohne Id neu angelegt. Datum und
     * Einleitungstext reisen optional mit. Ein bereits fakturierter Nachtrag
     * ist eingefroren.
     *
     * Überzeit-Zeilen (aus Rapporten) sind hier NICHT bearbeitbar — sie gehören
     * dem Rapport und bleiben, wie sie sind.
     */
    async replaceLines(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const id = String(req.params.id);
            const addon: any = await (prisma as any).salesOrder.findFirst({
                where: { id, tenantId, parentSalesOrderId: { not: null } },
            });
            if (!addon) return res.status(404).json({ error: 'Zusatzauftrag nicht gefunden.' });
            if (!addon.projectId) return res.status(400).json({ error: 'Dieser Zusatzauftrag trägt kein Projekt.' });
            // Ein STORNIERTER Nachtrag ist ein Beleg — er wird nicht mehr
            // bearbeitet (Vorgabe Samet 06.09.2026).
            if (addon.cancelledAt || addon.status === 'CANCELLED') {
                return res.status(400).json({ error: 'Ein stornierter Zusatzauftrag kann nicht mehr geändert werden.' });
            }

            const invoiceCount = await (prisma as any).invoice.count({ where: { salesOrderId: addon.id, tenantId } });
            if (invoiceCount > 0) return res.status(400).json({ error: 'Ein fakturierter Zusatzauftrag kann nicht mehr geändert werden.' });

            const hasLines = req.body?.lines !== undefined;
            const { products, texts } = hasLines ? normalizeLines(req.body.lines) : { products: [], texts: [] };
            const orderDate = parseOrderDate(req.body?.orderDate);
            if (orderDate === undefined && req.body?.orderDate !== undefined) {
                return res.status(400).json({ error: 'Datum ungültig.' });
            }
            const noteGiven = 'note' in (req.body ?? {});
            const note = noteGiven ? (typeof req.body.note === 'string' ? req.body.note.trim() || null : null) : undefined;
            const schedule = parsePaymentStagesInput(req.body?.paymentStages);
            if (schedule?.error) return res.status(400).json({ error: schedule.error });

            const articleIds = [...new Set(products.map((line) => line.articleId))];
            const articles: any[] = articleIds.length
                ? await (prisma as any).article.findMany({ where: { id: { in: articleIds }, tenantId }, select: { id: true, salePrice: true, name: true } })
                : [];
            const articleById = new Map<string, any>(articles.map((article) => [article.id, article]));
            if (articleIds.some((articleId) => !articleById.has(articleId))) {
                return res.status(400).json({ error: 'Ein Artikel wurde nicht gefunden.' });
            }

            const addonDiscounts = req.body?.discounts === undefined ? addon.addonDiscounts ?? null : normalizeDiscountList(req.body.discounts, MAX_TOTAL_DISCOUNTS);
            const previousLines = await this.loadAddonLines(addon);

            // MINDERUNG: dieselben Schranken wie beim Anlegen, gerechnet mit dem
            // kuenftigen Stand. Ohne neue Zeilen bleiben die eigenen Saetze stehen.
            if (hasLines || req.body?.discounts !== undefined) {
                const parent: any = await (prisma as any).salesOrder.findFirst({
                    where: { id: addon.parentSalesOrderId, tenantId },
                    select: { id: true, tenderId: true },
                });
                const priced = products.map((line) => priceAddonProduct(line, articleById.get(line.articleId)));
                const own = (line: any) => line.own;
                const inherited = (line: any) => !line.own;
                const projectedSubtotal = round2(
                    previousLines.materials.filter(inherited).reduce((sum: number, line: any) => sum + line.quantity * line.unitPrice, 0)
                    + previousLines.expenses.filter(inherited).reduce((sum: number, line: any) => sum + line.amount, 0)
                    + previousLines.overtime.reduce((sum: number, line: any) => sum + line.overtimeCost, 0)
                    + (hasLines
                        ? priced.reduce((sum, line) => sum + line.lineTotal, 0) + texts.reduce((sum, line) => sum + line.amount, 0)
                        : previousLines.materials.filter(own).reduce((sum: number, line: any) => sum + line.quantity * line.unitPrice, 0)
                            + previousLines.expenses.filter(own).reduce((sum: number, line: any) => sum + line.amount, 0)),
                );
                const nextTotal = round2(signedAfterDiscounts(projectedSubtotal, parseDiscountList(addonDiscounts, MAX_TOTAL_DISCOUNTS)));
                const minderungError = parent ? await validateMinderung({
                    tenantId,
                    parent,
                    addonId: addon.id,
                    products: priced,
                    nextTotal,
                    articleName: (articleId) => articleById.get(articleId)?.name || articleId,
                }) : null;
                if (minderungError) return res.status(409).json(minderungError);
            }
            const inheritedTotal = previousLines.materials.filter((line: any) => !line.own).reduce((sum: number, line: any) => sum + line.quantity * line.unitPrice, 0)
                + previousLines.expenses.filter((line: any) => !line.own).reduce((sum: number, line: any) => sum + line.amount, 0)
                + previousLines.overtime.filter((line: any) => !line.own).reduce((sum: number, line: any) => sum + line.overtimeCost, 0);
            const updated = await (prisma as any).$transaction(async (tx: any) => {
                if (hasLines) {
                    // Nur die EIGENEN Sätze des Nachtrags werden ersetzt —
                    // geerbte Fenster-Sätze alter Nachträge bleiben unberührt.
                    const existingMaterials: any[] = await tx.projectExtraMaterial.findMany({
                        where: { salesOrderId: addon.id },
                        select: { id: true, articleId: true, quantity: true },
                    });
                    const keptMaterialIds = new Set(products.map((line) => line.id).filter(Boolean));
                    for (const row of existingMaterials) {
                        if (keptMaterialIds.has(row.id)) continue;
                        // Gegenbuchung der Zeile (auch einer Minuszeile).
                        await bookConsumption(tx, {
                            tenantId, articleId: row.articleId, employeeId,
                            quantity: -Number(row.quantity || 0),
                            referenceId: addon.id, description: `Nachtrag ${addon.orderNumber} — Zeile entfernt`,
                        });
                        await tx.projectExtraMaterial.delete({ where: { id: row.id } });
                    }
                    const existingById = new Map<string, any>(existingMaterials.map((row) => [row.id, row]));
                    for (const product of products) {
                        const line = priceAddonProduct(product, articleById.get(product.articleId));
                        const unitPrice = line.unitPrice;
                        const current = line.id ? existingById.get(line.id) : null;
                        if (current) {
                            // Mengenänderung = Differenz im Lager; Artikelwechsel =
                            // alte Menge zurück, neue Menge heraus.
                            if (current.articleId !== line.articleId) {
                                await bookConsumption(tx, { tenantId, articleId: current.articleId, employeeId, quantity: -Number(current.quantity || 0), referenceId: addon.id, description: `Nachtrag ${addon.orderNumber} — Artikel gewechselt` });
                                await bookConsumption(tx, { tenantId, articleId: line.articleId, employeeId, quantity: line.quantity, referenceId: addon.id, description: `Nachtrag ${addon.orderNumber}` });
                            } else {
                                const diff = line.quantity - Number(current.quantity || 0);
                                if (diff !== 0) {
                                    await bookConsumption(tx, { tenantId, articleId: line.articleId, employeeId, quantity: diff, referenceId: addon.id, description: `Nachtrag ${addon.orderNumber} — Menge angepasst` });
                                }
                            }
                            await tx.projectExtraMaterial.update({
                                where: { id: current.id },
                                data: { articleId: line.articleId, quantity: line.quantity, unitPrice, description: line.description, documentLine: line.documentLine },
                            });
                        } else {
                            await tx.projectExtraMaterial.create({
                                data: {
                                    id: nanoid(10),
                                    projectId: addon.projectId,
                                    salesOrderId: addon.id,
                                    appointmentId: null,
                                    articleId: line.articleId,
                                    quantity: line.quantity,
                                    unitPrice,
                                    description: line.description,
                                    documentLine: line.documentLine,
                                    addedAt: addon.orderDate ?? addon.createdAt,
                                },
                            });
                            await bookConsumption(tx, { tenantId, articleId: line.articleId, employeeId, quantity: line.quantity, referenceId: addon.id, description: `Nachtrag ${addon.orderNumber}` });
                        }
                    }

                    const existingExpenses: any[] = await tx.projectExpense.findMany({
                        where: { salesOrderId: addon.id },
                        select: { id: true },
                    });
                    const keptExpenseIds = new Set(texts.map((line) => line.id).filter(Boolean));
                    const removedExpenseIds = existingExpenses.filter((row) => !keptExpenseIds.has(row.id)).map((row) => row.id);
                    if (removedExpenseIds.length) {
                        await tx.projectExpense.deleteMany({ where: { id: { in: removedExpenseIds } } });
                    }
                    const existingExpenseIds = new Set(existingExpenses.map((row) => row.id));
                    for (const line of texts) {
                        if (line.id && existingExpenseIds.has(line.id)) {
                            await tx.projectExpense.update({
                                where: { id: line.id },
                                data: { expenseType: line.description, amount: line.amount, description: line.longDescription ?? '', documentLine: line.documentLine },
                            });
                        } else {
                            await tx.projectExpense.create({
                                data: {
                                    id: nanoid(10),
                                    projectId: addon.projectId,
                                    salesOrderId: addon.id,
                                    appointmentId: null,
                                    expenseType: line.description,
                                    amount: line.amount,
                                    description: line.longDescription ?? '',
                                    documentLine: line.documentLine,
                                    expenseDate: addon.orderDate ?? addon.createdAt,
                                },
                            });
                        }
                    }
                }

                // Der Betrag des Nachtrags folgt seinen Sätzen — ALLEN, auch
                // den Überzeiten der Rapporte, die hier nicht angefasst werden.
                const [materialSum, expenseSum, overtimeSum] = await Promise.all([
                    tx.projectExtraMaterial.findMany({ where: { salesOrderId: addon.id }, select: { quantity: true, unitPrice: true } }),
                    tx.projectExpense.aggregate({ where: { salesOrderId: addon.id }, _sum: { amount: true } }),
                    tx.projectReport.aggregate({ where: { salesOrderId: addon.id }, _sum: { overtimeCost: true } }),
                ]);
                const subtotal = round2(
                    inheritedTotal + materialSum.reduce((sum: number, row: any) => sum + Number(row.quantity || 0) * Number(row.unitPrice || 0), 0)
                    + Number(expenseSum._sum?.amount || 0)
                    + Number(overtimeSum._sum?.overtimeCost || 0),
                );

                const totalAmount = round2(signedAfterDiscounts(subtotal, parseDiscountList(addonDiscounts, MAX_TOTAL_DISCOUNTS)));
                return tx.salesOrder.update({
                    where: { id: addon.id },
                    data: {
                        totalAmount,
                        addonDiscounts,
                        ...(orderDate !== undefined ? { orderDate } : {}),
                        ...(note !== undefined ? { confirmationNote: note } : {}),
                        ...(schedule ? { paymentStages: schedule.value ?? null } : {}),
                    },
                    select: { id: true, orderNumber: true, totalAmount: true, orderDate: true, confirmationNote: true, paymentStages: true },
                });
            });

            res.status(200).json({ message: 'Zusatzauftrag gespeichert.', salesOrder: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
