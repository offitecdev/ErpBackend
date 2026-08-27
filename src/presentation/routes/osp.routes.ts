import { Router } from 'express';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { findTenantRootIdCached, getAllTenants, collectDescendantIds } from '../../shared/tenantTree';
import { nextDocumentNumber } from '../../shared/documentNumber';
import {
    OSP_ENUM_TO_INTERNAL,
    OSP_STATUS_RANK,
    OSP_WIRE_STATUS,
    fetchOspOfferStatus,
    reportOspOfferStatus,
    type OspStatusRow,
} from '../../infrastructure/services/OspClient';

/**
 * ── OSP-MODUL (Offitec Selection Platform, 04.09.2026) ──────────────────────
 * Eingehender Webhook der OSP-Offertanfragen, die Belegliste der OSP-Seite
 * (/sales/osp), Statuspflege mit Rückmeldung an die OSP und der Offerten-
 * Import ("Offerte aus OSP erzeugen").
 *
 * Grundsätze:
 *  • Der Feed hängt am WURZEL-Mandanten; welche Mandanten ihn sehen, sagt
 *    `OspSetting.tenantIds` (Einstellungen → Module → Verkauf → OSP).
 *  • OSP-Zeilen legen NIEMALS Artikel oder Bestand an — der Import erzeugt
 *    eine Offerte mit reinen Textpositionen (rowType CUSTOM), nur für diese
 *    eine Offerte.
 *  • Der Kunde des Imports darf ein CRM-Kunde sein ODER von Hand eingegeben
 *    werden (Tender.manualCustomer*) — von Hand heisst: NIRGENDS registriert.
 *  • Jede Meldung an die OSP ist Best-Effort; Ausgang + Fehler stehen an der
 *    Zeile (lastReport*).
 */

const router = Router();

const OSP_STATUSES = ['LISTED', 'IN_OFFER', 'SENT', 'APPROVED'] as const;
type OspStatus = (typeof OSP_STATUSES)[number];

const SETTINGS_MANAGE = ['tenders.manage', 'roles.manage', 'tenants.update'];

/** Standard-Seitengrösse der Liste — "in Gruppen von 15 ziehen" (Vorgabe). */
const PAGE_SIZE = 15;

/* ── kleine Helfer ──────────────────────────────────────────────────────── */

const asTrimmed = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

/** Schlüsselvergleich in konstanter Zeit — es ist eine Authentifizierung. */
const keysMatch = (a: string, b: string): boolean => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
};

/** "4820193-57" → { projectNumber: "4820193", documentId: "57" }. */
const parseReference = (reference: string): { projectNumber: string; documentId: string | null } => {
    const splitAt = reference.lastIndexOf('-');
    if (splitAt <= 0) return { projectNumber: reference, documentId: null };
    return { projectNumber: reference.slice(0, splitAt), documentId: reference.slice(splitAt + 1) };
};

const parseTenantIds = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
        } catch { return []; }
    }
    return [];
};

interface FeedContext {
    rootId: string;
    setting: any | null;
    /** Darf der AKTUELLE Mandant den Feed sehen? (Wurzel immer, sonst Auswahl.) */
    visible: boolean;
}

/** Wurzel + Einstellungen + Sichtbarkeit für den angemeldeten Mandanten. */
const loadFeedContext = async (tenantId: string): Promise<FeedContext | null> => {
    const rootId = await findTenantRootIdCached(tenantId);
    if (!rootId) return null;
    const setting = await (prisma as any).ospSetting.findUnique({ where: { tenantId: rootId } });
    const selected = parseTenantIds(setting?.tenantIds);
    const visible = tenantId === rootId || selected.includes(tenantId);
    return { rootId, setting, visible };
};

/** Meldung an die OSP + Protokoll an der Zeile — Best-Effort, wirft nie. */
const reportDocumentStatus = async (
    setting: any | null,
    doc: { id: string; reference: string },
    internalStatus: string,
    salesmanEmail?: string | null,
): Promise<void> => {
    const wireStatus = OSP_WIRE_STATUS[internalStatus];
    if (!wireStatus || !setting) return;
    const result = await reportOspOfferStatus(setting, doc.reference, wireStatus, salesmanEmail);
    await (prisma as any).ospDocument.update({
        where: { id: doc.id },
        data: result.ok
            ? { lastReportedStatus: wireStatus, lastReportAt: new Date(), lastReportError: null }
            : {
                lastReportError: result.skipped
                    ? 'OSP-Zugang nicht konfiguriert (Basisadresse/Schlüssel fehlen).'
                    : result.error || 'Unbekannter Fehler.',
            },
    }).catch(() => undefined);
};

const employeeDisplayName = (employee: { firstName?: string | null; lastName?: string | null; email?: string | null }): string =>
    [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || employee.email || '';

/* ── 1) Eingehender Webhook (OHNE JWT — gemeinsamer Schlüssel) ───────────── */

router.post('/webhook', async (req, res) => {
    try {
        const key = asTrimmed(req.header('x-osp-integration-key'));
        const settings = await (prisma as any).ospSetting.findMany({
            where: { NOT: { webhookKey: null } },
        });
        const armed = settings.filter((row: any) => asTrimmed(row.webhookKey));
        // Kein konfigurierter Schlüssel → niemals offen durchfallen (wie die
        // OSP selbst: 503 statt offen).
        if (!armed.length) {
            return res.status(503).json({ message: 'OSP integration key is not configured.' });
        }
        const setting = key ? armed.find((row: any) => keysMatch(asTrimmed(row.webhookKey) || '', key)) : null;
        if (!setting) return res.status(401).json({ message: 'Missing or wrong X-OSP-Integration-Key.' });

        const body = Array.isArray(req.body) ? req.body : (req.body ? [req.body] : []);
        const entries = body.filter((entry) => entry && typeof entry === 'object');
        if (!entries.length) return res.status(400).json({ message: 'Empty payload.' });

        const created: Array<{ id: string; reference: string }> = [];
        let updated = 0;

        for (const entry of entries) {
            const reference = asTrimmed((entry as any).projectNumber);
            if (!reference) continue;
            const { projectNumber, documentId } = parseReference(reference);
            const ospCreatedAtRaw = asTrimmed((entry as any).created_at);
            const ospCreatedAt = ospCreatedAtRaw && !Number.isNaN(Date.parse(ospCreatedAtRaw))
                ? new Date(ospCreatedAtRaw)
                : null;

            // Beschreibende Felder werden bei JEDER Lieferung aufgefrischt;
            // der Bearbeitungsstand und die Zuständigkeit bleiben unangetastet
            // (erneute Lieferung derselben Anfrage ist erlaubt und sicher).
            const descriptive = {
                projectNumber,
                documentId,
                projectName: asTrimmed((entry as any).projectName) || '',
                requesterFirstName: asTrimmed((entry as any).username),
                requesterLastName: asTrimmed((entry as any).surname),
                requesterEmail: asTrimmed((entry as any).email),
                company: asTrimmed((entry as any).company),
                country: asTrimmed((entry as any).country),
                city: asTrimmed((entry as any).city),
                address: asTrimmed((entry as any).address),
                postalCode: asTrimmed((entry as any).postalCode),
                userType: asTrimmed((entry as any).userType),
                category: asTrimmed((entry as any).category),
                unitType: asTrimmed((entry as any).type),
                model: asTrimmed((entry as any).model),
                ospCreatedAt,
            };

            const existing = await (prisma as any).ospDocument.findUnique({
                where: { tenantId_reference: { tenantId: setting.tenantId, reference } },
                select: { id: true },
            });
            if (existing) {
                await (prisma as any).ospDocument.update({ where: { id: existing.id }, data: descriptive });
                updated += 1;
            } else {
                const row = await (prisma as any).ospDocument.create({
                    data: { id: nanoid(12), tenantId: setting.tenantId, reference, status: 'LISTED', ...descriptive },
                    select: { id: true, reference: true },
                });
                created.push(row);
            }
        }

        // Antwort sofort — die "created"-Bestätigung an die OSP ist Kür und
        // läuft im Hintergrund (Best-Effort, §3: salesman dabei optional).
        res.status(200).json({ received: entries.length, created: created.length, updated });
        for (const row of created) {
            void reportDocumentStatus(setting, row, 'LISTED').catch(() => undefined);
        }
    } catch (error: any) {
        res.status(500).json({ message: error?.message || 'Webhook failed.' });
    }
});

/* ── 2) Belegliste der OSP-Seite (Seiten zu 15) ──────────────────────────── */

router.get('/documents', requireAuth, requirePermission('tenders.view'), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        if (!feed.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE));
        const status = asTrimmed(req.query.status as string);
        const q = asTrimmed(req.query.q as string);

        const where: any = { tenantId: feed.rootId };
        if (status && (OSP_STATUSES as readonly string[]).includes(status)) where.status = status;
        if (q) {
            where.OR = [
                { reference: { contains: q } },
                { projectName: { contains: q } },
                { model: { contains: q } },
                { requesterFirstName: { contains: q } },
                { requesterLastName: { contains: q } },
                { requesterEmail: { contains: q } },
                { company: { contains: q } },
                { country: { contains: q } },
            ];
        }

        const [items, total, grouped] = await Promise.all([
            (prisma as any).ospDocument.findMany({
                where,
                orderBy: [{ ospCreatedAt: 'desc' }, { createdAt: 'desc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            (prisma as any).ospDocument.count({ where }),
            (prisma as any).ospDocument.groupBy({
                by: ['status'],
                where: { tenantId: feed.rootId },
                _count: { _all: true },
            }),
        ]);

        /* Selbstpflege des Standes: hängt an einer Zeile eine Offerte, deren
           Angebotsmail inzwischen HINAUS ist, rückt die Zeile von IN_OFFER auf
           SENT vor — und die OSP bekommt "offer has been sent" gemeldet. So
           braucht der Mailweg der Offerte keinen OSP-Haken. */
        const mailCandidates = items.filter((doc: any) => doc.status === 'IN_OFFER' && doc.tenderId);
        if (mailCandidates.length) {
            const tenders = await prisma.tender.findMany({
                where: { id: { in: mailCandidates.map((doc: any) => doc.tenderId) } },
                select: { id: true, offerMailSentAt: true },
            });
            const sentTenders = new Set(tenders.filter((t) => t.offerMailSentAt).map((t) => t.id));
            for (const doc of mailCandidates) {
                if (!sentTenders.has(doc.tenderId)) continue;
                doc.status = 'SENT';
                await (prisma as any).ospDocument.update({ where: { id: doc.id }, data: { status: 'SENT' } });
                void reportDocumentStatus(feed.setting, doc, 'SENT', doc.salespersonEmail).catch(() => undefined);
            }
        }

        const counts: Record<OspStatus, number> = { LISTED: 0, IN_OFFER: 0, SENT: 0, APPROVED: 0 };
        for (const row of grouped as Array<{ status: string; _count: { _all: number } }>) {
            if ((OSP_STATUSES as readonly string[]).includes(row.status)) {
                counts[row.status as OspStatus] = row._count._all;
            }
        }

        res.json({
            items,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            counts,
            configured: Boolean(feed.setting),
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Liste fehlgeschlagen.' });
    }
});

/* ── 3) Zeile pflegen: Status / zuständige Person / Rolle ────────────────── */

router.patch('/documents/:id', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const doc = await (prisma as any).ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
        });
        if (!doc) return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });

        const data: any = {};
        const body = req.body || {};

        if (body.status !== undefined) {
            const status = String(body.status || '').toUpperCase();
            if (!(OSP_STATUSES as readonly string[]).includes(status)) {
                return res.status(400).json({ error: 'Unbekannter Status.' });
            }
            data.status = status;
        }

        if (body.salespersonRole !== undefined) {
            const role = String(body.salespersonRole || '').toUpperCase();
            if (role !== 'SALES' && role !== 'PROJECT_MANAGER') {
                return res.status(400).json({ error: 'Unbekannte Rolle.' });
            }
            data.salespersonRole = role;
        }

        if (body.salespersonId !== undefined) {
            if (!body.salespersonId) {
                data.salespersonId = null;
                data.salespersonEmail = null;
                data.salespersonName = null;
            } else {
                // Person kommt aus dem Personalverzeichnis — Name und E-Mail
                // werden hier aufgelöst, nie vom Client übernommen.
                const treeIds = collectDescendantIds(await getAllTenants(), feed.rootId);
                const employee = await prisma.employee.findFirst({
                    where: { id: String(body.salespersonId), tenantId: { in: treeIds } },
                    select: { id: true, firstName: true, lastName: true, email: true },
                });
                if (!employee) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
                data.salespersonId = employee.id;
                data.salespersonEmail = employee.email || null;
                data.salespersonName = employeeDisplayName(employee);
            }
        }

        const nextStatus: string = data.status ?? doc.status;
        const nextEmail: string | null = data.salespersonEmail !== undefined ? data.salespersonEmail : doc.salespersonEmail;
        // "under review" und "offer has been sent" sind ohne zuständige Person
        // bedeutungslos — die OSP lehnt sie ab (400), also lehnen wir zuerst ab.
        if ((nextStatus === 'IN_OFFER' || nextStatus === 'SENT') && !nextEmail) {
            return res.status(400).json({ error: 'Für diesen Status muss zuerst eine zuständige Person gewählt werden.' });
        }

        const updatedDoc = await (prisma as any).ospDocument.update({ where: { id: doc.id }, data });

        // Nur eine ECHTE Änderung meldet an die OSP (erneute Zustellung wäre
        // drüben zwar sicher, hier aber sinnlos).
        const statusChanged = nextStatus !== doc.status;
        const personChanged = nextEmail !== doc.salespersonEmail;
        if ((statusChanged || personChanged) && (nextStatus === 'IN_OFFER' || nextStatus === 'SENT')) {
            await reportDocumentStatus(feed.setting, updatedDoc, nextStatus, nextEmail);
        }

        res.json(await (prisma as any).ospDocument.findUnique({ where: { id: doc.id } }));
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht gespeichert werden.' });
    }
});

/* ── 4) Import: Offerte aus einem OSP-Beleg erzeugen ─────────────────────── */

router.post('/documents/:id/import', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const user = (req as any).user!;
        const feed = await loadFeedContext(user.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const doc = await (prisma as any).ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
        });
        if (!doc) return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        if (doc.tenderId) {
            const existing = await prisma.tender.findFirst({ where: { id: doc.tenderId }, select: { id: true } });
            if (existing) return res.status(409).json({ error: 'Zu diesem Beleg besteht bereits eine Offerte.', tenderId: doc.tenderId });
        }

        const body = req.body || {};
        const customerId = asTrimmed(body.customerId);
        const manual = body.manualCustomer && typeof body.manualCustomer === 'object' ? body.manualCustomer : null;
        const manualName = manual ? asTrimmed(manual.name) : null;
        if (!customerId && !manualName) {
            return res.status(400).json({ error: 'Kunde wählen oder von Hand erfassen.' });
        }
        if (customerId) {
            const customer = await prisma.customer.findFirst({
                where: { id: customerId, tenantId: user.tenantId },
                select: { id: true },
            });
            if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });
        }

        const rawPositions = Array.isArray(body.positions) ? body.positions : [];
        const positions = rawPositions
            .map((row: any) => ({
                title: asTrimmed(row?.title),
                descriptionHtml: typeof row?.descriptionHtml === 'string' ? row.descriptionHtml : null,
                quantity: Number.isFinite(Number(row?.quantity)) ? Math.max(0, Number(row.quantity)) : 1,
                unit: asTrimmed(row?.unit) || 'Stk',
                unitPrice: Number.isFinite(Number(row?.unitPrice)) ? Math.max(0, Number(row.unitPrice)) : 0,
                taxRate: Number.isFinite(Number(row?.taxRate)) ? Math.max(0, Number(row.taxRate)) : 8.1,
            }))
            .filter((row: any) => row.title);
        if (!positions.length) return res.status(400).json({ error: 'Mindestens eine Position angeben.' });

        // Zuständige Person: gewählt oder die anlegende Person selbst.
        let salesperson = doc.salespersonId
            ? { id: doc.salespersonId, email: doc.salespersonEmail, name: doc.salespersonName }
            : null;
        const requestedSalespersonId = asTrimmed(body.salespersonId);
        if (requestedSalespersonId) {
            const treeIds = collectDescendantIds(await getAllTenants(), feed.rootId);
            const employee = await prisma.employee.findFirst({
                where: { id: requestedSalespersonId, tenantId: { in: treeIds } },
                select: { id: true, firstName: true, lastName: true, email: true },
            });
            if (!employee) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
            salesperson = { id: employee.id, email: employee.email || null, name: employeeDisplayName(employee) };
        }
        if (!salesperson) {
            salesperson = { id: user.id, email: user.email || null, name: employeeDisplayName(user) };
        }

        // Mehrzeilige manuelle Adresse: Strasse / PLZ Ort / Land.
        const manualAddress = manual
            ? [
                asTrimmed(manual.address),
                [asTrimmed(manual.postalCode), asTrimmed(manual.city)].filter(Boolean).join(' ') || null,
                asTrimmed(manual.country),
            ].filter(Boolean).join('\n') || null
            : null;

        const tenderNumber = await nextDocumentNumber(user.tenantId, 'QUOTE');
        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 30);

        const tender = await prisma.tender.create({
            data: {
                id: nanoid(10),
                tenantId: user.tenantId,
                customerId: customerId || null,
                tenderNumber,
                version: 1,
                format: 'SIA451',
                status: 'Draft',
                validUntil,
                // Die OSP-Referenz ist die "Referenz" der Offerte — so findet
                // man den Beleg auf dem PDF und in der OSP wieder.
                customerReference: doc.reference,
                salespersonName: salesperson.name || null,
                manualCustomerName: customerId ? null : manualName,
                manualCustomerEmail: customerId ? null : (manual ? asTrimmed(manual.email) : null),
                manualCustomerAddress: customerId ? null : manualAddress,
                // Popup'ta düzenlenen adres yalnız bu teklifin adresidir.
                // Bir CRM müşterisi seçilmiş olsa da müşteri kartına yazılmaz.
                billingAddress: manualAddress,
                createdByEmployeeId: user.id,
            } as any,
        });

        // Reine Textpositionen — bewusst OHNE Artikelbezug: nichts davon
        // erscheint je im Lager oder im Artikelstamm.
        await prisma.position.createMany({
            data: positions.map((row: any, index: number) => ({
                id: nanoid(10),
                tenantId: user.tenantId,
                tenderId: tender.id,
                rowType: 'CUSTOM',
                positionNumber: String(index + 1),
                shortDescription: row.title,
                longDescription: row.descriptionHtml,
                quantity: row.quantity,
                unit: row.unit,
                unitPrice: row.unitPrice,
                taxRate: row.taxRate,
                displayOrder: index,
                hierarchyLevel: 0,
            })),
        });

        await (prisma as any).tenderActivityLog.create({
            data: {
                id: nanoid(12),
                tenantId: user.tenantId,
                tenderId: tender.id,
                employeeId: user.id,
                actionType: 'TENDER_CREATED',
                newValue: tenderNumber,
                description: `${tenderNumber} aus OSP-Beleg ${doc.reference} erzeugt.`,
            },
        }).catch(() => undefined);

        const updatedDoc = await (prisma as any).ospDocument.update({
            where: { id: doc.id },
            data: {
                status: 'IN_OFFER',
                tenderId: tender.id,
                tenderNumber,
                salespersonId: salesperson.id,
                salespersonEmail: salesperson.email,
                salespersonName: salesperson.name,
            },
        });

        // "under review" braucht die zuständige Person — ohne E-Mail-Adresse
        // wird gar nicht gemeldet (die OSP würde mit 400 ablehnen).
        if (salesperson.email) {
            await reportDocumentStatus(feed.setting, updatedDoc, 'IN_OFFER', salesperson.email);
        }

        res.status(201).json({ tenderId: tender.id, tenderNumber, document: updatedDoc });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Import fehlgeschlagen.' });
    }
});

/* ── 5) Abgleich mit der OSP ("Transfer") — in Gruppen von 15 ────────────── */

router.post('/sync', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        if (!feed.setting) return res.status(400).json({ error: 'OSP ist noch nicht konfiguriert.' });

        const docs = await (prisma as any).ospDocument.findMany({
            where: { tenantId: feed.rootId },
            select: { id: true, reference: true, projectNumber: true, status: true, salespersonEmail: true, salespersonName: true },
        });
        if (!docs.length) return res.json({ checked: 0, updated: 0, failed: 0 });

        // EINE Abfrage je Projektnummer holt alle Belege des Projekts (§4) —
        // und gezogen wird in Gruppen von 15 (Vorgabe).
        const projectNumbers: string[] = Array.from(new Set(docs.map((d: any) => String(d.projectNumber)).filter(Boolean)));
        const byReference = new Map<string, OspStatusRow>();
        let failed = 0;
        for (let start = 0; start < projectNumbers.length; start += 15) {
            const chunk = projectNumbers.slice(start, start + 15);
            const results = await Promise.all(chunk.map((projectNumber) => fetchOspOfferStatus(feed.setting, projectNumber)));
            for (const result of results) {
                if (!result.ok) { failed += 1; continue; }
                for (const row of result.rows || []) {
                    if (row?.reference) byReference.set(String(row.reference), row);
                }
            }
        }

        let updated = 0;
        for (const doc of docs) {
            const row = byReference.get(doc.reference);
            if (!row) continue;
            const mapped = OSP_ENUM_TO_INTERNAL[String(row.status || '').toUpperCase()] || null;
            const data: any = {};
            // Der Abgleich bewegt den Stand nur VORWÄRTS — was hier weiter ist
            // (z. B. APPROVED, das die OSP nicht kennt), bleibt stehen.
            if (mapped && (OSP_STATUS_RANK[mapped] ?? -1) > (OSP_STATUS_RANK[doc.status] ?? 0)) {
                data.status = mapped;
            }
            if (mapped) data.lastReportedStatus = OSP_WIRE_STATUS[mapped] ?? doc.lastReportedStatus;
            const salesmanEmail = asTrimmed(row.salesman?.email as string | undefined);
            if (salesmanEmail && !doc.salespersonEmail) {
                data.salespersonEmail = salesmanEmail;
                data.salespersonName = [row.salesman?.name, row.salesman?.surname].filter(Boolean).join(' ') || doc.salespersonName;
            }
            if (Object.keys(data).length) {
                await (prisma as any).ospDocument.update({ where: { id: doc.id }, data });
                updated += 1;
            }
        }

        res.json({ checked: docs.length, updated, failed });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Abgleich fehlgeschlagen.' });
    }
});

/* ── 6) Einstellungen (Einstellungen → Module → Verkauf → OSP) ───────────── */

router.get('/settings', requireAuth, requireAnyPermission(SETTINGS_MANAGE), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const rootId = await findTenantRootIdCached(tenantId);
        if (!rootId) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        const setting = await (prisma as any).ospSetting.findUnique({ where: { tenantId: rootId } });
        res.json({
            rootTenantId: rootId,
            tenantIds: parseTenantIds(setting?.tenantIds),
            webhookKey: setting?.webhookKey || '',
            ospBaseUrl: setting?.ospBaseUrl || '',
            hasApiKey: Boolean(asTrimmed(setting?.ospApiKey)),
            // Die Adresse, die der OSP als OFFER_WEBHOOK_URL zu nennen ist —
            // relativ; die Oberfläche stellt den eigenen Ursprung davor.
            webhookPath: '/backend/api/v1/osp/webhook',
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen fehlgeschlagen.' });
    }
});

router.put('/settings', requireAuth, requireAnyPermission(SETTINGS_MANAGE), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const rootId = await findTenantRootIdCached(tenantId);
        if (!rootId) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });

        const body = req.body || {};
        const data: any = {};

        if (body.tenantIds !== undefined) {
            const requested = parseTenantIds(body.tenantIds);
            const treeIds = new Set(collectDescendantIds(await getAllTenants(), rootId));
            data.tenantIds = requested.filter((id) => treeIds.has(id));
        }
        if (body.webhookKey !== undefined) data.webhookKey = asTrimmed(body.webhookKey);
        if (body.ospBaseUrl !== undefined) data.ospBaseUrl = asTrimmed(body.ospBaseUrl);
        // Schlüssel wie beim Mailkonto: leer = behalten, null = löschen.
        if (body.ospApiKey === null) data.ospApiKey = null;
        else if (asTrimmed(body.ospApiKey)) data.ospApiKey = asTrimmed(body.ospApiKey);

        const setting = await (prisma as any).ospSetting.upsert({
            where: { tenantId: rootId },
            create: { id: nanoid(12), tenantId: rootId, ...data },
            update: data,
        });

        res.json({
            rootTenantId: rootId,
            tenantIds: parseTenantIds(setting.tenantIds),
            webhookKey: setting.webhookKey || '',
            ospBaseUrl: setting.ospBaseUrl || '',
            hasApiKey: Boolean(asTrimmed(setting.ospApiKey)),
            webhookPath: '/backend/api/v1/osp/webhook',
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen konnten nicht gespeichert werden.' });
    }
});

export default router;
