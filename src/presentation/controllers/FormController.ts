import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import {
    computeFieldVisibility,
    missingRequiredFields,
    normalizeFormFields,
    sanitizeFormValues,
    type FormFieldDef,
    type FormValues,
} from '../../shared/formFields';

/**
 * Checklisten / Formulare / Vorlagen — branchenneutral.
 *
 *  • Vorlagen (FormTemplate): Name + geordnete Feldliste (Text, Zahl, Menge,
 *    Meter, Kilogramm, cm, mm, Kontrollkästchen, Auswahl, Foto, Datei,
 *    Zeichnung, Unterschrift, Datum, Abschnitt) mit bedingten Feldern
 *    ("Kernbohrung nötig? = Ja" → Bohrdurchmesser, Wandstärke, Anzahl Löcher).
 *  • Abgaben (FormSubmission): ausgefüllte Vorlagen am Kunden. Über die
 *    Verknüpfungs-Ids (Angebot / Auftrag / Projekt / Termin) sind sie entlang
 *    der ganzen Kette sichtbar — der Technikerbildschirm eines Termins findet,
 *    was schon beim Angebot erfasst wurde (Masse, Fotos, Zeichnungen …).
 *  • Hinweise (FieldNote): freie Einsatz-Hinweise ("ohne Schuhe eintreten"),
 *    unabhängig von Vorlagen, sichtbar im Projekt, seinen Aufträgen und beim
 *    Techniker.
 *
 * Mandantenzuschnitt wie im übrigen CRM: exakter tenantId der Anfrage.
 *
 * SCHWERLAST-REGEL: `values` (Fotos/Dateien/Zeichnungen/Unterschriften als
 * Data-URLs) und der eingefrorene Feldsatz kommen NUR beim Einzelabruf; jede
 * Liste ist ein schlanker Join ohne diese Spalten. Die Listen laufen als ein
 * $queryRaw mit den Beschriftungen (Kunde, Angebots-/Auftrags-/Projektnummer)
 * gejoint — eine Runde zur entfernten Datenbank statt fünf (siehe crm.routes).
 */

const SUBMISSION_STATUSES = new Set(['DRAFT', 'COMPLETED']);

type SubmissionListRow = {
    id: string;
    templateId: string | null;
    templateName: string;
    status: string;
    customerId: string | null;
    customerName: string | null;
    customerLanguage: string | null;
    tenderId: string | null;
    tenderNumber: string | null;
    salesOrderId: string | null;
    orderNumber: string | null;
    projectId: string | null;
    projectNumber: string | null;
    appointmentId: string | null;
    appointmentStart: Date | null;
    /** Zahl der Verknüpfungen und der beteiligten Kunden/Angebote. */
    linkCount: number;
    customerCount: number;
    tenderCount: number;
    /** Alle verknüpften Kundennamen als eine Zeile (Listenspalte). */
    linkedCustomerNames: string | null;
    filledByEmployeeId: string | null;
    filledByName: string | null;
    notes: string | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

/** Verknüpfungskette eines Kontexts (welche Ids zusammengehören). */
export interface FormContext {
    kind: 'customer' | 'tender' | 'salesOrder' | 'project' | 'appointment';
    id: string;
    customerId: string | null;
    customerName: string | null;
    tenderId: string | null;
    tenderNumber: string | null;
    salesOrderId: string | null;
    orderNumber: string | null;
    projectId: string | null;
    projectNumber: string | null;
    projectName: string | null;
    appointmentId: string | null;
    appointmentStart: Date | null;
    /** Alle Angebots-Ids der Kette (Projekt: die seiner Aufträge). */
    tenderIds: string[];
    /** Alle Auftrags-Ids der Kette (Projekt: alle Aufträge inkl. Zusatzaufträge). */
    salesOrderIds: string[];
}

/* Die flachen Spalten tragen die ERSTE Verknüpfung (Beschriftungen, PDF-Kopf);
   die Zähler und die Namenszeile darunter kommen aus FormSubmissionLink, denn
   eine Checkliste hängt seit dem 16.08.2026 an MEHREREN Kunden. Die
   Unterabfragen laufen je Zeile, treffen aber jeweils den Index auf
   submissionId — bei 25 Zeilen je Seite bleibt das eine Runde. */
const SUBMISSION_LIST_SELECT = Prisma.sql`
    SELECT s.id, s.templateId, s.templateName, s.status, s.customerId, s.tenderId, s.salesOrderId,
           s.projectId, s.appointmentId, s.filledByEmployeeId, s.filledByName, s.notes,
           s.completedAt, s.createdAt, s.updatedAt,
           cu.companyName AS customerName, cu.language AS customerLanguage,
           te.tenderNumber AS tenderNumber,
           so.orderNumber AS orderNumber,
           pr.projectNumber AS projectNumber,
           ap.startTime AS appointmentStart,
           (SELECT COUNT(*) FROM FormSubmissionLink lc WHERE lc.submissionId = s.id) AS linkCount,
           (SELECT COUNT(DISTINCT lk.customerId) FROM FormSubmissionLink lk WHERE lk.submissionId = s.id AND lk.customerId IS NOT NULL) AS customerCount,
           (SELECT COUNT(DISTINCT lt.tenderId) FROM FormSubmissionLink lt WHERE lt.submissionId = s.id AND lt.tenderId IS NOT NULL) AS tenderCount,
           (SELECT GROUP_CONCAT(DISTINCT lcu.companyName ORDER BY lcu.companyName SEPARATOR ', ')
              FROM FormSubmissionLink ln
              JOIN Customer lcu ON lcu.id = ln.customerId
             WHERE ln.submissionId = s.id) AS linkedCustomerNames
      FROM FormSubmission s
      LEFT JOIN Customer cu ON cu.id = s.customerId
      LEFT JOIN Tender te ON te.id = s.tenderId
      LEFT JOIN SalesOrder so ON so.id = s.salesOrderId
      LEFT JOIN Project pr ON pr.id = s.projectId
      LEFT JOIN Appointment ap ON ap.id = s.appointmentId
`;

const mapListRow = (row: Record<string, any>): SubmissionListRow => ({
    id: row.id,
    templateId: row.templateId ?? null,
    templateName: row.templateName,
    status: row.status,
    customerId: row.customerId ?? null,
    customerName: row.customerName ?? null,
    customerLanguage: row.customerLanguage ?? null,
    tenderId: row.tenderId ?? null,
    tenderNumber: row.tenderNumber ?? null,
    salesOrderId: row.salesOrderId ?? null,
    orderNumber: row.orderNumber ?? null,
    projectId: row.projectId ?? null,
    projectNumber: row.projectNumber ?? null,
    appointmentId: row.appointmentId ?? null,
    appointmentStart: row.appointmentStart ?? null,
    linkCount: Number(row.linkCount ?? 0),
    customerCount: Number(row.customerCount ?? 0),
    tenderCount: Number(row.tenderCount ?? 0),
    linkedCustomerNames: row.linkedCustomerNames ?? null,
    filledByEmployeeId: row.filledByEmployeeId ?? null,
    filledByName: row.filledByName ?? null,
    notes: row.notes ?? null,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const parsePage = (req: Request) => {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'), 10) || 25));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

const employeeName = async (employeeId: string): Promise<string | null> => {
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { firstName: true, lastName: true },
    });
    if (!employee) return null;
    return [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || null;
};

/** Zahl der Felder einer Vorlage ohne Abschnittsüberschriften. */
const countInputFields = (fields: unknown): number =>
    Array.isArray(fields) ? fields.filter((field: any) => field?.type !== 'SECTION').length : 0;

const linkIds = (body: Record<string, unknown>) => ({
    customerId: String(body.customerId || '').trim() || null,
    tenderId: String(body.tenderId || '').trim() || null,
    salesOrderId: String(body.salesOrderId || '').trim() || null,
    projectId: String(body.projectId || '').trim() || null,
    appointmentId: String(body.appointmentId || '').trim() || null,
});

type Links = ReturnType<typeof linkIds>;

/**
 * Löst eine Verknüpfungskette auf: was gegeben ist, gewinnt; alles Fehlende
 * wird von der genauesten Angabe her ergänzt (Termin → Auftrag/Projekt/Kunde,
 * Auftrag → Angebot/Projekt/Kunde, Projekt → Angebot/Kunde, Angebot → Kunde).
 * Ids anderer Mandanten werden verworfen. Die Stufen laufen nacheinander,
 * weil jede die Ids der vorigen ergänzt — höchstens fünf kleine Abfragen.
 */
async function completeLinks(tenantId: string, links: Links): Promise<Links> {
    const out: Links = { ...links };
    if (out.appointmentId) {
        const appointment = await prisma.appointment.findFirst({
            where: { id: out.appointmentId, tenantId },
            select: { id: true, projectId: true, salesOrderId: true, customerId: true },
        });
        if (!appointment) out.appointmentId = null;
        else {
            out.projectId ||= appointment.projectId;
            out.salesOrderId ||= appointment.salesOrderId;
            out.customerId ||= appointment.customerId;
        }
    }
    if (out.salesOrderId) {
        const order = await prisma.salesOrder.findFirst({
            where: { id: out.salesOrderId, tenantId },
            select: { id: true, tenderId: true, projectId: true, customerId: true, parentSalesOrder: { select: { tenderId: true } } },
        });
        if (!order) out.salesOrderId = null;
        else {
            out.tenderId ||= order.tenderId || order.parentSalesOrder?.tenderId || null;
            out.projectId ||= order.projectId;
            out.customerId ||= order.customerId;
        }
    }
    if (out.projectId) {
        const project = await prisma.project.findFirst({
            where: { id: out.projectId, tenantId },
            select: { id: true, tenderId: true, customerId: true },
        });
        if (!project) out.projectId = null;
        else {
            out.tenderId ||= project.tenderId;
            out.customerId ||= project.customerId;
        }
    }
    if (out.tenderId) {
        const tender = await prisma.tender.findFirst({
            where: { id: out.tenderId, tenantId },
            select: { id: true, customerId: true, projectId: true },
        });
        if (!tender) out.tenderId = null;
        else {
            out.customerId ||= tender.customerId;
            out.projectId ||= tender.projectId;
        }
    }
    if (out.customerId) {
        const customer = await prisma.customer.findFirst({ where: { id: out.customerId, tenantId }, select: { id: true } });
        if (!customer) out.customerId = null;
    }
    return out;
}

const EMPTY_LINKS: Links = { customerId: null, tenderId: null, salesOrderId: null, projectId: null, appointmentId: null };

const hasAnyLink = (link: Links) => Object.values(link).some(Boolean);
const linkKey = (link: Links) => [link.customerId, link.tenderId, link.salesOrderId, link.projectId, link.appointmentId].join('|');

/**
 * Die Verknüpfungen aus dem Anfragekörper: entweder die neue Liste `links`
 * (eine Checkliste an mehreren Kunden — Vorgabe 16.08.2026) oder die alten
 * Einzelfelder `customerId`/`tenderId`/… als EINE Verknüpfung. Beides bleibt
 * gültig, damit ältere Aufrufer (Technikerbildschirm, Kundenakte) weiterlaufen.
 */
function readLinkList(body: Record<string, any>): Links[] {
    if (Array.isArray(body.links)) {
        return body.links
            .map((entry: unknown) => linkIds((entry || {}) as Record<string, unknown>))
            .filter(hasAnyLink);
    }
    const single = linkIds(body);
    return hasAnyLink(single) ? [single] : [];
}

/**
 * Jede Verknüpfung wird für sich zur ganzen Kette ergänzt (Angebot → Auftrag →
 * Projekt → Kunde). Gleiche Zeilen laufen nur einmal, doppelte Ergebnisse
 * fallen weg: zwei Zeilen desselben Kunden mit demselben Angebot sind EINE
 * Verknüpfung.
 */
async function completeLinkList(tenantId: string, list: Links[]): Promise<Links[]> {
    const unique = new Map<string, Links>();
    for (const entry of list) if (!unique.has(linkKey(entry))) unique.set(linkKey(entry), entry);
    const resolved = await Promise.all([...unique.values()].map((entry) => completeLinks(tenantId, entry)));
    const out = new Map<string, Links>();
    for (const entry of resolved) if (hasAnyLink(entry)) out.set(linkKey(entry), entry);
    return [...out.values()];
}

/** Verknüpfungszeilen schreiben (`replace` löscht die bisherigen zuerst). */
async function writeLinks(tenantId: string, submissionId: string, links: Links[], replace: boolean): Promise<void> {
    if (replace) await prisma.formSubmissionLink.deleteMany({ where: { submissionId } });
    if (!links.length) return;
    await prisma.formSubmissionLink.createMany({
        data: links.map((link) => ({ id: nanoid(12), tenantId, submissionId, ...link })),
    });
}

/** Die Verknüpfungen einer Checkliste mit Beschriftungen (Einzelabruf). */
async function readLinks(submissionId: string): Promise<Array<Record<string, any>>> {
    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT l.id, l.customerId, l.tenderId, l.salesOrderId, l.projectId, l.appointmentId,
               cu.companyName AS customerName,
               te.tenderNumber AS tenderNumber,
               so.orderNumber AS orderNumber,
               pr.projectNumber AS projectNumber,
               ap.startTime AS appointmentStart
          FROM FormSubmissionLink l
          LEFT JOIN Customer cu ON cu.id = l.customerId
          LEFT JOIN Tender te ON te.id = l.tenderId
          LEFT JOIN SalesOrder so ON so.id = l.salesOrderId
          LEFT JOIN Project pr ON pr.id = l.projectId
          LEFT JOIN Appointment ap ON ap.id = l.appointmentId
         WHERE l.submissionId = ${submissionId}
         ORDER BY cu.companyName ASC, te.tenderNumber ASC, l.id ASC
    `);
    return rows.map((row) => ({
        id: row.id,
        customerId: row.customerId ?? null,
        customerName: row.customerName ?? null,
        tenderId: row.tenderId ?? null,
        tenderNumber: row.tenderNumber ?? null,
        salesOrderId: row.salesOrderId ?? null,
        orderNumber: row.orderNumber ?? null,
        projectId: row.projectId ?? null,
        projectNumber: row.projectNumber ?? null,
        appointmentId: row.appointmentId ?? null,
        appointmentStart: row.appointmentStart ?? null,
    }));
}

/**
 * Der Kontext eines Bildschirms (Kundenakte, Angebot, Auftrag, Projekt,
 * Termin) samt Beschriftungen und der vollständigen Kette. Projekt und Termin
 * sammeln ALLE Aufträge des Projekts (Haupt- und Zusatzaufträge) und deren
 * Angebote ein, damit ein beim Angebot erfasstes Formular auch am Termin des
 * daraus entstandenen Projekts steht.
 */
export async function resolveFormContext(tenantId: string, kind: string, id: string): Promise<FormContext | null> {
    const base: FormContext = {
        kind: kind as FormContext['kind'], id,
        customerId: null, customerName: null,
        tenderId: null, tenderNumber: null,
        salesOrderId: null, orderNumber: null,
        projectId: null, projectNumber: null, projectName: null,
        appointmentId: null, appointmentStart: null,
        tenderIds: [], salesOrderIds: [],
    };

    if (kind === 'customer') {
        const customer = await prisma.customer.findFirst({ where: { id, tenantId }, select: { id: true, companyName: true } });
        if (!customer) return null;
        return { ...base, customerId: customer.id, customerName: customer.companyName };
    }

    let links: Links = { customerId: null, tenderId: null, salesOrderId: null, projectId: null, appointmentId: null };
    if (kind === 'tender') links.tenderId = id;
    else if (kind === 'salesOrder') links.salesOrderId = id;
    else if (kind === 'project') links.projectId = id;
    else if (kind === 'appointment') links.appointmentId = id;
    else return null;

    links = await completeLinks(tenantId, links);
    // Der Ausgangspunkt selbst muss existieren, sonst gibt es keinen Kontext.
    if ((kind === 'tender' && !links.tenderId) || (kind === 'salesOrder' && !links.salesOrderId)
        || (kind === 'project' && !links.projectId) || (kind === 'appointment' && !links.appointmentId)) {
        return null;
    }

    const [customer, tender, order, project, appointment, projectOrders] = await Promise.all([
        links.customerId ? prisma.customer.findUnique({ where: { id: links.customerId }, select: { companyName: true } }) : null,
        links.tenderId ? prisma.tender.findUnique({ where: { id: links.tenderId }, select: { tenderNumber: true } }) : null,
        links.salesOrderId ? prisma.salesOrder.findUnique({ where: { id: links.salesOrderId }, select: { orderNumber: true } }) : null,
        links.projectId ? prisma.project.findUnique({ where: { id: links.projectId }, select: { projectNumber: true, projectName: true } }) : null,
        links.appointmentId ? prisma.appointment.findUnique({ where: { id: links.appointmentId }, select: { startTime: true } }) : null,
        links.projectId
            ? prisma.salesOrder.findMany({ where: { projectId: links.projectId, tenantId }, select: { id: true, tenderId: true } })
            : Promise.resolve([] as Array<{ id: string; tenderId: string | null }>),
    ]);

    const tenderIds = new Set<string>();
    const salesOrderIds = new Set<string>();
    if (links.tenderId) tenderIds.add(links.tenderId);
    if (links.salesOrderId) salesOrderIds.add(links.salesOrderId);
    for (const row of projectOrders) {
        salesOrderIds.add(row.id);
        if (row.tenderId) tenderIds.add(row.tenderId);
    }

    return {
        ...base,
        customerId: links.customerId,
        customerName: customer?.companyName ?? null,
        tenderId: links.tenderId,
        tenderNumber: tender?.tenderNumber ?? null,
        salesOrderId: links.salesOrderId,
        orderNumber: order?.orderNumber ?? null,
        projectId: links.projectId,
        projectNumber: project?.projectNumber ?? null,
        projectName: project?.projectName ?? null,
        appointmentId: links.appointmentId,
        appointmentStart: appointment?.startTime ?? null,
        tenderIds: [...tenderIds],
        salesOrderIds: [...salesOrderIds],
    };
}

/**
 * WHERE-Bedingung "gehört zur Kette dieses Kontexts": direkt am Termin /
 * Projekt / einem der Aufträge / einem der Angebote. Für die Kundenakte:
 * alles des Kunden.
 *
 * `customerFallback` entscheidet über die rein am KUNDEN hängenden Einträge
 * (ohne Angebot/Auftrag/Projekt/Termin):
 *  • Hinweise (FieldNote) führen ihn — "bitte ohne Schuhe eintreten" gilt für
 *    jeden Einsatz bei diesem Kunden, auch ohne Beleg;
 *  • Checklisten NICHT (Vorgabe 16.08.2026): eine Checkliste erscheint in
 *    Auftrag, Projekt, Montage und Rapport nur, wenn sie ausdrücklich mit dem
 *    Angebot (oder direkt mit dem Beleg) verknüpft wurde. Ohne Verknüpfung
 *    bleibt sie in der Kundenakte und in der Checklisten-Liste.
 */
function contextCondition(
    context: FormContext,
    alias: string,
    opts: { hasTender: boolean; customerFallback?: boolean; viaLinks?: boolean } = { hasTender: true },
): Prisma.Sql {
    // Checklisten hängen seit dem 16.08.2026 an MEHREREN Kunden: dort steht die
    // Bedingung auf der Verknüpfungstabelle und wird als EXISTS an die Zeile
    // gehängt. Hinweise (FieldNote) haben weiter nur ihre eigenen Spalten.
    const on = opts.viaLinks ? 'fl' : alias;
    const col = (name: string) => Prisma.raw(`${on}.${name}`);
    const build = (): Prisma.Sql => {
        if (context.kind === 'customer') return Prisma.sql`${col('customerId')} = ${context.customerId}`;
        const parts: Prisma.Sql[] = [];
        if (context.appointmentId) parts.push(Prisma.sql`${col('appointmentId')} = ${context.appointmentId}`);
        if (context.projectId) parts.push(Prisma.sql`${col('projectId')} = ${context.projectId}`);
        if (context.salesOrderIds.length) parts.push(Prisma.sql`${col('salesOrderId')} IN (${Prisma.join(context.salesOrderIds)})`);
        // FieldNote hat KEINE tenderId-Spalte (Hinweise hängen frühestens am
        // Kunden/Projekt) — für sie entfällt der Angebots-Zweig.
        if (opts.hasTender && context.tenderIds.length) parts.push(Prisma.sql`${col('tenderId')} IN (${Prisma.join(context.tenderIds)})`);
        if (context.customerId && opts.customerFallback !== false) {
            const tenderFree = opts.hasTender ? Prisma.sql`AND ${col('tenderId')} IS NULL` : Prisma.empty;
            parts.push(Prisma.sql`(${col('customerId')} = ${context.customerId} ${tenderFree} AND ${col('salesOrderId')} IS NULL AND ${col('projectId')} IS NULL AND ${col('appointmentId')} IS NULL)`);
        }
        if (parts.length === 0) return Prisma.sql`1 = 0`;
        return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
    };
    const condition = build();
    if (!opts.viaLinks) return condition;
    return Prisma.sql`EXISTS (SELECT 1 FROM FormSubmissionLink fl WHERE fl.submissionId = ${Prisma.raw(`${alias}.id`)} AND ${condition})`;
}

export class FormController {
    // ───────────────────────────── Vorlagen ─────────────────────────────

    async listTemplates(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const search = String(req.query.search || '').trim();
            const active = String(req.query.active || '').trim();
            const where: Prisma.FormTemplateWhereInput = { tenantId };
            if (active === 'true') where.isActive = true;
            if (active === 'false') where.isActive = false;
            if (search) where.OR = [{ name: { contains: search } }, { category: { contains: search } }];
            const [templates, usage] = await Promise.all([
                prisma.formTemplate.findMany({ where, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
                prisma.formSubmission.groupBy({ by: ['templateId'], where: { tenantId, templateId: { not: null } }, _count: { _all: true } }),
            ]);
            const usageById = new Map(usage.map((row) => [row.templateId, row._count._all]));
            res.status(200).json(templates.map((template) => ({
                ...template,
                fieldCount: countInputFields(template.fields),
                submissionCount: usageById.get(template.id) ?? 0,
            })));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getTemplate(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const template = await prisma.formTemplate.findFirst({ where: { id: String(req.params.id), tenantId } });
            if (!template) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
            res.status(200).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createTemplate(req: Request, res: Response) {
        try {
            const user = req.user!;
            const body = req.body || {};
            const name = String(body.name || '').trim();
            if (!name) return res.status(400).json({ error: 'Name der Vorlage fehlt.' });
            const fields = normalizeFormFields(body.fields);
            const template = await prisma.formTemplate.create({
                data: {
                    id: nanoid(10),
                    tenantId: user.tenantId,
                    name,
                    description: body.description ? String(body.description).slice(0, 2000) : null,
                    category: body.category ? String(body.category).trim().slice(0, 100) : null,
                    fields: fields as unknown as Prisma.InputJsonValue,
                    isActive: body.isActive !== false,
                    createdByEmployeeId: user.id,
                },
            });
            res.status(201).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateTemplate(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const existing = await prisma.formTemplate.findFirst({ where: { id: String(req.params.id), tenantId } });
            if (!existing) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
            const data: Prisma.FormTemplateUpdateInput = {};
            if (body.name !== undefined) {
                const name = String(body.name).trim();
                if (!name) return res.status(400).json({ error: 'Name der Vorlage fehlt.' });
                data.name = name;
            }
            if (body.description !== undefined) data.description = body.description ? String(body.description).slice(0, 2000) : null;
            if (body.category !== undefined) data.category = body.category ? String(body.category).trim().slice(0, 100) : null;
            if (body.fields !== undefined) data.fields = normalizeFormFields(body.fields) as unknown as Prisma.InputJsonValue;
            if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
            const template = await prisma.formTemplate.update({ where: { id: existing.id }, data });
            res.status(200).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async duplicateTemplate(req: Request, res: Response) {
        try {
            const user = req.user!;
            const existing = await prisma.formTemplate.findFirst({ where: { id: String(req.params.id), tenantId: user.tenantId } });
            if (!existing) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
            // Kopie mit NEUEN Feld-Ids — sonst würden zwei Vorlagen dieselben
            // Schlüssel tragen und Abgaben liessen sich nicht auseinanderhalten.
            const fields = normalizeFormFields(existing.fields).map((field) => ({ ...field, id: nanoid(8) }));
            const template = await prisma.formTemplate.create({
                data: {
                    id: nanoid(10),
                    tenantId: user.tenantId,
                    name: `${existing.name} (Kopie)`,
                    description: existing.description,
                    category: existing.category,
                    fields: fields as unknown as Prisma.InputJsonValue,
                    isActive: false,
                    createdByEmployeeId: user.id,
                },
            });
            res.status(201).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteTemplate(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await prisma.formTemplate.findFirst({ where: { id: String(req.params.id), tenantId }, select: { id: true } });
            if (!existing) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
            // Abgaben behalten ihren eingefrorenen Feldsatz; die Verknüpfung
            // zur Vorlage wird gelöst (FK SET NULL).
            await prisma.formTemplate.delete({ where: { id: existing.id } });
            res.status(200).json({ message: 'Vorlage gelöscht.' });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // ───────────────────────────── Abgaben ──────────────────────────────

    /**
     * GET /forms/submissions?search=&status=&templateId=&customerId=&tenderId=
     *   &salesOrderId=&projectId=&appointmentId=&page=&pageSize=
     * Filter sind UND-verknüpft (Modulliste). Für "alles der Kette" siehe
     * getContext.
     */
    async listSubmissions(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const { page, pageSize, skip, take } = parsePage(req);
            const conditions: Prisma.Sql[] = [Prisma.sql`s.tenantId = ${tenantId}`];
            const status = String(req.query.status || '').trim().toUpperCase();
            if (SUBMISSION_STATUSES.has(status)) conditions.push(Prisma.sql`s.status = ${status}`);
            const templateId = String(req.query.templateId || '').trim();
            if (templateId) conditions.push(Prisma.sql`s.templateId = ${templateId}`);
            // Kunde/Angebot/… treffen JEDE Verknüpfung, nicht nur die erste —
            // sonst fände der Kundenfilter eine geteilte Checkliste nur bei dem
            // Kunden, der zufällig zuerst verknüpft wurde.
            for (const key of ['customerId', 'tenderId', 'salesOrderId', 'projectId', 'appointmentId'] as const) {
                const value = String(req.query[key] || '').trim();
                if (value) {
                    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM FormSubmissionLink fl WHERE fl.submissionId = s.id AND ${Prisma.raw(`fl.${key}`)} = ${value})`);
                }
            }
            const search = String(req.query.search || '').trim();
            if (search) {
                const like = `%${search}%`;
                conditions.push(Prisma.sql`(s.templateName LIKE ${like} OR cu.companyName LIKE ${like} OR te.tenderNumber LIKE ${like} OR so.orderNumber LIKE ${like} OR pr.projectNumber LIKE ${like} OR s.filledByName LIKE ${like}
                    OR EXISTS (SELECT 1 FROM FormSubmissionLink fs JOIN Customer fc ON fc.id = fs.customerId WHERE fs.submissionId = s.id AND fc.companyName LIKE ${like})
                    OR EXISTS (SELECT 1 FROM FormSubmissionLink ft JOIN Tender fte ON fte.id = ft.tenderId WHERE ft.submissionId = s.id AND fte.tenderNumber LIKE ${like}))`);
            }
            const whereSql = Prisma.join(conditions, ' AND ');
            const [rows, countRows] = await Promise.all([
                prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                    ${SUBMISSION_LIST_SELECT}
                    WHERE ${whereSql}
                    ORDER BY s.createdAt DESC, s.id DESC
                    LIMIT ${take} OFFSET ${skip}
                `),
                prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                    SELECT COUNT(*) AS total
                      FROM FormSubmission s
                      LEFT JOIN Customer cu ON cu.id = s.customerId
                      LEFT JOIN Tender te ON te.id = s.tenderId
                      LEFT JOIN SalesOrder so ON so.id = s.salesOrderId
                      LEFT JOIN Project pr ON pr.id = s.projectId
                     WHERE ${whereSql}
                `),
            ]);
            res.status(200).json({ data: rows.map(mapListRow), total: Number(countRows[0]?.total ?? 0), page, pageSize });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * GET /forms/context/:kind/:id — kind ∈ customer | tender | salesOrder |
     * project | appointment. Liefert die aufgelöste Kette, ALLE dazugehörigen
     * Abgaben (schlank) und die Einsatz-Hinweise — eine Anfrage je Bildschirm.
     */
    async getContext(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const context = await resolveFormContext(tenantId, String(req.params.kind), String(req.params.id));
            if (!context) return res.status(404).json({ error: 'Kontext nicht gefunden.' });

            const [submissionRows, noteRows] = await Promise.all([
                prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                    ${SUBMISSION_LIST_SELECT}
                    WHERE s.tenantId = ${tenantId} AND ${contextCondition(context, 's', { hasTender: true, customerFallback: false, viaLinks: true })}
                    ORDER BY s.createdAt DESC, s.id DESC
                    LIMIT 200
                `),
                prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                    SELECT n.id, n.customerId, n.projectId, n.salesOrderId, n.appointmentId, n.text,
                           n.createdByEmployeeId, n.createdByName, n.createdAt, n.updatedAt,
                           pr.projectNumber AS projectNumber, so.orderNumber AS orderNumber
                      FROM FieldNote n
                      LEFT JOIN Project pr ON pr.id = n.projectId
                      LEFT JOIN SalesOrder so ON so.id = n.salesOrderId
                     WHERE n.tenantId = ${tenantId} AND ${contextCondition(context, 'n', { hasTender: false })}
                     ORDER BY n.createdAt DESC
                     LIMIT 100
                `),
            ]);

            res.status(200).json({
                context,
                submissions: submissionRows.map(mapListRow),
                notes: noteRows,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getSubmission(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                ${SUBMISSION_LIST_SELECT}
                WHERE s.tenantId = ${tenantId} AND s.id = ${String(req.params.id)}
                LIMIT 1
            `);
            const row = rows[0];
            if (!row) return res.status(404).json({ error: 'Formular nicht gefunden.' });
            // Schwerlast (eingefrorene Felder + Werte mit Data-URLs) getrennt und
            // NUR hier — die Listenabfrage oben bleibt schlank. Die
            // Verknüpfungsliste (alle Kunden dieser Checkliste) kommt in
            // derselben Runde dazu, der Editor braucht sie für Schritt 2.
            const [heavy, links] = await Promise.all([
                prisma.formSubmission.findUnique({
                    where: { id: row.id },
                    select: { templateFields: true, values: true },
                }),
                readLinks(row.id),
            ]);
            res.status(200).json({
                ...mapListRow(row),
                links,
                templateFields: heavy?.templateFields ?? [],
                values: heavy?.values ?? {},
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * POST /forms/submissions — { templateId, links?: [{ customerId, tenderId,
     *   … }], customerId?, tenderId?, …, values?, notes?, status? }
     * Friert die Felder der Vorlage ein und ergänzt jede Verknüpfungskette.
     *
     * Vorgabe 16.08.2026: EINE Checkliste für mehrere Kunden. `links` trägt
     * alle Paare (Kunde, Angebot) auf einmal; die erste Zeile steht zusätzlich
     * in den flachen Spalten, damit Beschriftungen und PDF-Kopf unverändert
     * funktionieren.
     */
    async createSubmission(req: Request, res: Response) {
        try {
            const user = req.user!;
            const body = req.body || {};
            const templateId = String(body.templateId || '').trim();
            if (!templateId) return res.status(400).json({ error: 'Vorlage fehlt.' });
            const template = await prisma.formTemplate.findFirst({ where: { id: templateId, tenantId: user.tenantId } });
            if (!template) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
            const fields = normalizeFormFields(template.fields);
            const links = await completeLinkList(user.tenantId, readLinkList(body));
            const primary = links[0] ?? EMPTY_LINKS;
            const values = sanitizeFormValues(fields, body.values);
            const status = String(body.status || 'DRAFT').toUpperCase() === 'COMPLETED' ? 'COMPLETED' : 'DRAFT';
            if (status === 'COMPLETED') {
                const missing = missingRequiredFields(fields, values);
                if (missing.length) return res.status(400).json({ error: 'Pflichtfelder fehlen.', missingFields: missing });
            }
            const filledByName = await employeeName(user.id);
            const created = await prisma.formSubmission.create({
                data: {
                    id: nanoid(10),
                    tenantId: user.tenantId,
                    templateId: template.id,
                    templateName: template.name,
                    templateFields: fields as unknown as Prisma.InputJsonValue,
                    ...primary,
                    status,
                    values: values as Prisma.InputJsonValue,
                    notes: body.notes ? String(body.notes).slice(0, 5000) : null,
                    filledByEmployeeId: user.id,
                    filledByName,
                    completedAt: status === 'COMPLETED' ? new Date() : null,
                },
            });
            await writeLinks(user.tenantId, created.id, links, false);
            res.status(201).json({ ...created, links: await readLinks(created.id) });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * PUT /forms/submissions/:id — { values?, notes?, status?, customerId?, … }
     * Ersetzt die Werte vollständig (der letzte Speicherstand gilt). Der
     * Wechsel auf COMPLETED prüft die sichtbaren Pflichtfelder; ein Zurück auf
     * DRAFT ist erlaubt (Wiedereröffnen).
     */
    async updateSubmission(req: Request, res: Response) {
        try {
            const user = req.user!;
            const body = req.body || {};
            const existing = await prisma.formSubmission.findFirst({ where: { id: String(req.params.id), tenantId: user.tenantId } });
            if (!existing) return res.status(404).json({ error: 'Formular nicht gefunden.' });
            const fields = normalizeFormFields(existing.templateFields);
            const values = body.values !== undefined ? sanitizeFormValues(fields, body.values) : (existing.values as FormValues);
            const data: Prisma.FormSubmissionUncheckedUpdateInput = {
                values: values as Prisma.InputJsonValue,
                filledByEmployeeId: user.id,
                filledByName: (await employeeName(user.id)) ?? existing.filledByName,
            };
            if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).slice(0, 5000) : null;
            if (body.status !== undefined) {
                const status = String(body.status).toUpperCase();
                if (!SUBMISSION_STATUSES.has(status)) return res.status(400).json({ error: 'Status DRAFT oder COMPLETED erwartet.' });
                if (status === 'COMPLETED') {
                    const missing = missingRequiredFields(fields, values);
                    if (missing.length) return res.status(400).json({ error: 'Pflichtfelder fehlen.', missingFields: missing });
                    data.completedAt = existing.completedAt ?? new Date();
                } else {
                    data.completedAt = null;
                }
                data.status = status;
            }
            /* Verknüpfungen nachträglich ändern. Die Liste `links` ERSETZT den
               ganzen Satz — so kommen Kunden dazu oder fallen weg. Die alten
               Einzelfelder ändern nur die erste Verknüpfung; das Autospeichern
               schickt gar keine Verknüpfung und darf hier nichts anfassen. */
            const linkKeys = ['customerId', 'tenderId', 'salesOrderId', 'projectId', 'appointmentId'] as const;
            const wantsLinkChange = Array.isArray(body.links) || linkKeys.some((key) => body[key] !== undefined);
            let nextLinks: Links[] | null = null;
            if (wantsLinkChange) {
                const requested: Links[] = Array.isArray(body.links)
                    ? readLinkList(body)
                    : [{
                        customerId: body.customerId !== undefined ? (String(body.customerId || '').trim() || null) : existing.customerId,
                        tenderId: body.tenderId !== undefined ? (String(body.tenderId || '').trim() || null) : existing.tenderId,
                        salesOrderId: body.salesOrderId !== undefined ? (String(body.salesOrderId || '').trim() || null) : existing.salesOrderId,
                        projectId: body.projectId !== undefined ? (String(body.projectId || '').trim() || null) : existing.projectId,
                        appointmentId: body.appointmentId !== undefined ? (String(body.appointmentId || '').trim() || null) : existing.appointmentId,
                    }];
                nextLinks = await completeLinkList(user.tenantId, requested);
                Object.assign(data, nextLinks[0] ?? EMPTY_LINKS);
            }
            const updated = await prisma.formSubmission.update({ where: { id: existing.id }, data });
            if (nextLinks) await writeLinks(user.tenantId, existing.id, nextLinks, true);
            res.status(200).json({ ...updated, links: await readLinks(existing.id) });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteSubmission(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await prisma.formSubmission.findFirst({ where: { id: String(req.params.id), tenantId }, select: { id: true } });
            if (!existing) return res.status(404).json({ error: 'Formular nicht gefunden.' });
            await prisma.formSubmission.delete({ where: { id: existing.id } });
            res.status(200).json({ message: 'Formular gelöscht.' });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * GET /forms/submissions/:id/visibility — welche Felder mit den gespeicherten
     * Werten sichtbar sind (Hilfe für Drittnutzer/PDF-Dienste; die Oberfläche
     * rechnet dasselbe lokal).
     */
    async getSubmissionVisibility(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await prisma.formSubmission.findFirst({
                where: { id: String(req.params.id), tenantId },
                select: { templateFields: true, values: true },
            });
            if (!existing) return res.status(404).json({ error: 'Formular nicht gefunden.' });
            const fields = normalizeFormFields(existing.templateFields) as FormFieldDef[];
            res.status(200).json(computeFieldVisibility(fields, (existing.values as FormValues) || {}));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // ───────────────────────────── Hinweise ─────────────────────────────

    async listNotes(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const conditions: Prisma.Sql[] = [Prisma.sql`n.tenantId = ${tenantId}`];
            const ors: Prisma.Sql[] = [];
            const projectId = String(req.query.projectId || '').trim();
            const customerId = String(req.query.customerId || '').trim();
            const salesOrderId = String(req.query.salesOrderId || '').trim();
            const appointmentId = String(req.query.appointmentId || '').trim();
            if (projectId) ors.push(Prisma.sql`n.projectId = ${projectId}`);
            if (salesOrderId) ors.push(Prisma.sql`n.salesOrderId = ${salesOrderId}`);
            if (appointmentId) ors.push(Prisma.sql`n.appointmentId = ${appointmentId}`);
            if (customerId) ors.push(Prisma.sql`(n.customerId = ${customerId} AND n.projectId IS NULL)`);
            if (ors.length) conditions.push(Prisma.sql`(${Prisma.join(ors, ' OR ')})`);
            const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT n.id, n.customerId, n.projectId, n.salesOrderId, n.appointmentId, n.text,
                       n.createdByEmployeeId, n.createdByName, n.createdAt, n.updatedAt,
                       pr.projectNumber AS projectNumber, so.orderNumber AS orderNumber
                  FROM FieldNote n
                  LEFT JOIN Project pr ON pr.id = n.projectId
                  LEFT JOIN SalesOrder so ON so.id = n.salesOrderId
                 WHERE ${Prisma.join(conditions, ' AND ')}
                 ORDER BY n.createdAt DESC
                 LIMIT 200
            `);
            res.status(200).json(rows);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createNote(req: Request, res: Response) {
        try {
            const user = req.user!;
            const body = req.body || {};
            const text = String(body.text || '').trim();
            if (!text) return res.status(400).json({ error: 'Hinweistext fehlt.' });
            const links = await completeLinks(user.tenantId, linkIds(body));
            if (!links.customerId && !links.projectId && !links.salesOrderId && !links.appointmentId) {
                return res.status(400).json({ error: 'Ein Hinweis braucht einen Bezug (Kunde, Projekt, Auftrag oder Termin).' });
            }
            // FieldNote kennt kein tenderId — mitgeschickt kippt Prisma in die
            // Relations-Schreibweise und lehnt customerId ab.
            const { tenderId: _tenderId, ...noteLinks } = links;
            void _tenderId;
            const created = await prisma.fieldNote.create({
                data: {
                    id: nanoid(10),
                    tenantId: user.tenantId,
                    ...noteLinks,
                    text: text.slice(0, 5000),
                    createdByEmployeeId: user.id,
                    createdByName: await employeeName(user.id),
                },
            });
            res.status(201).json(created);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateNote(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await prisma.fieldNote.findFirst({ where: { id: String(req.params.id), tenantId }, select: { id: true } });
            if (!existing) return res.status(404).json({ error: 'Hinweis nicht gefunden.' });
            const text = String(req.body?.text || '').trim();
            if (!text) return res.status(400).json({ error: 'Hinweistext fehlt.' });
            const updated = await prisma.fieldNote.update({ where: { id: existing.id }, data: { text: text.slice(0, 5000) } });
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteNote(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await prisma.fieldNote.findFirst({ where: { id: String(req.params.id), tenantId }, select: { id: true } });
            if (!existing) return res.status(404).json({ error: 'Hinweis nicht gefunden.' });
            await prisma.fieldNote.delete({ where: { id: existing.id } });
            res.status(200).json({ message: 'Hinweis gelöscht.' });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
