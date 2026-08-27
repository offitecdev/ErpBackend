import { Router } from 'express';
import { nanoid } from 'nanoid';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { listLabels, LABEL_ORDER_BY, type LabelRow } from '../../application/services/calendarLabelCatalog';
import { DEFAULT_CALENDAR_LABELS, FALLBACK_LABEL_COLOR, normalizeLabelColor, normalizeLabelName, normalizeLabelRole } from '../../shared/calendarLabels';

/* KALENDER-ETIKETTEN (Kalender → Leiste «Etiketten», Zahnrad daneben).
   Je Mandant EINE Liste, aus der ein Kalendereintrag sein Etikett bekommt.
   Sie beginnt LEER: es gibt keinen Erstbestand, nur ein Plus. Ein Etikett ist
   ein Name, eine Farbe und eine Rolle (APPOINTMENT | MEETING) — die Rolle
   sagt nur, was beim Anlegen dieser Art vorgeschlagen wird.

   LESEN darf jede:r Angemeldete — ohne die Liste kann der Kalender keine
   einzige Karte faerben. AENDERN darf, wer Termine setzen oder die Firma
   verwalten darf: die Liste gilt fuer alle, die auf denselben Kalender
   schauen, ein Umbenennen ist deshalb kein persoenlicher Handgriff. */

const router = Router();

const MANAGE = [
    'projects.manage',
    'crm.activities.create',
    'roles.manage',
    'tenants.update',
];

const toDto = (row: LabelRow) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sortOrder,
    role: row.role,
    hidden: row.hidden,
});

/* Je Rolle steht EIN sichtbares Etikett. Genau das macht das «+» beherrschbar:
   es bietet die Rollen an, die noch frei sind. Ausgeblendete zaehlen nicht --
   ihre Rolle ist wieder zu haben. */
const roleTaken = (labels: ReadonlyArray<LabelRow>, role: string | null, exceptId?: string) =>
    Boolean(role) && labels.some((label) => label.role === role && !label.hidden && label.id !== exceptId);

/** Wie viele Eintraege dieses Etikett heute tragen — die Loeschmeldung nennt die Zahl. */
const usageCount = async (tenantId: string, labelId: string): Promise<number> => {
    const [appointments, meetings, tasks] = await Promise.all([
        prisma.appointment.count({ where: { tenantId, labelId } }),
        prisma.meetingActivity.count({ where: { tenantId, labelId } }),
        prisma.crmTask.count({ where: { tenantId, labelId } }),
    ]);
    return appointments + meetings + tasks;
};

// GET /calendar/labels — die ganze Liste, in Anzeigereihenfolge.
router.get('/', requireAuth, async (req, res) => {
    try {
        const rows = await listLabels(req.user!.tenantId);
        res.status(200).json(rows.map(toDto));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/* POST /calendar/labels — { name, color?, role? } ein Etikett anlegen.
   Ohne Rolle ist es ein reines Farbetikett. Eine Rolle, die bereits ein
   sichtbares Etikett traegt, wird abgelehnt: sonst gaebe es zwei Vorschlaege
   fuer dieselbe Sache. Ein Etikett mit Rolle setzt sich an DEREN Platz in der
   Reihenfolge, ein farbiges haengt sich hinten an. */
router.post('/', requireAuth, requireAnyPermission(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const name = normalizeLabelName(req.body?.name);
        if (!name) return res.status(400).json({ error: 'Der Name des Etiketts fehlt.' });
        const color = normalizeLabelColor(req.body?.color) ?? FALLBACK_LABEL_COLOR;

        const existing = await listLabels(tenantId);
        const clash = existing.find((label) => label.name.toLowerCase() === name.toLowerCase());
        if (clash) return res.status(409).json({ error: `Das Etikett «${clash.name}» gibt es bereits.` });

        /* JEDES ETIKETT HAT EINE ROLLE (Vorgabe 25.08.2026: «ein ‹ohne Rolle›
           soll es nicht geben — gespeichert werden nur Rollen, damit man
           Eintraege daran haengen kann»). Ohne Rolle waere es ein Farbfleck,
           an dem nichts haengt. */
        const role = normalizeLabelRole(req.body?.role);
        if (!role) return res.status(400).json({ error: 'Die Rolle des Etiketts fehlt.' });
        if (roleTaken(existing, role)) {
            return res.status(409).json({ error: 'Für diese Rolle gibt es bereits ein Etikett.', code: 'ROLE_TAKEN' });
        }

        const seeded = DEFAULT_CALENDAR_LABELS.find((seed) => seed.role === role);
        const sortOrder = seeded?.sortOrder ?? existing.reduce((max, label) => Math.max(max, label.sortOrder), 0) + 10;
        const created = await prisma.calendarLabel.create({
            data: { id: nanoid(12), tenantId, name, color, sortOrder, role, hidden: false },
        });
        res.status(201).json(toDto(created));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/* PATCH /calendar/labels/:id — { name?, color?, role?, hidden?, sortOrder? }.
   Alles daran laesst sich aendern; `role: null` nimmt die Rolle wieder weg,
   `hidden` raeumt es weg, ohne etwas wegzuwerfen. Ein Etikett wieder
   EINZUBLENDEN geht nur, solange seine Rolle frei ist. */
router.patch('/:id', requireAuth, requireAnyPermission(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const current = await prisma.calendarLabel.findFirst({ where: { id: String(req.params.id), tenantId } });
        if (!current) return res.status(404).json({ error: 'Etikett nicht gefunden.' });

        const data: { name?: string; color?: string; sortOrder?: number; role?: string | null; hidden?: boolean } = {};
        const existing = await listLabels(tenantId);

        if (req.body?.name !== undefined) {
            const name = normalizeLabelName(req.body.name);
            if (!name) return res.status(400).json({ error: 'Der Name des Etiketts fehlt.' });
            if (name.toLowerCase() !== current.name.toLowerCase()) {
                const clash = await prisma.calendarLabel.findFirst({
                    where: { tenantId, name, NOT: { id: current.id } },
                    select: { name: true },
                });
                if (clash) return res.status(409).json({ error: `Das Etikett «${clash.name}» gibt es bereits.` });
            }
            data.name = name;
        }
        if (req.body?.color !== undefined) {
            const color = normalizeLabelColor(req.body.color);
            if (!color) return res.status(400).json({ error: 'Die Farbe muss als #rrggbb angegeben werden.' });
            data.color = color;
        }
        if (req.body?.role !== undefined) {
            const role = normalizeLabelRole(req.body.role);
            if (!role) return res.status(400).json({ error: 'Die Rolle des Etiketts fehlt.' });
            if (roleTaken(existing, role, current.id)) {
                return res.status(409).json({ error: 'Für diese Rolle gibt es bereits ein Etikett.', code: 'ROLE_TAKEN' });
            }
            data.role = role;
        }
        if (req.body?.hidden !== undefined) {
            const hidden = req.body.hidden === true;
            const role = (data.role !== undefined ? data.role : current.role);
            if (!hidden && roleTaken(existing, role, current.id)) {
                return res.status(409).json({ error: 'Für diese Rolle gibt es bereits ein Etikett.', code: 'ROLE_TAKEN' });
            }
            data.hidden = hidden;
        }
        if (req.body?.sortOrder !== undefined) {
            const sortOrder = Number(req.body.sortOrder);
            if (!Number.isFinite(sortOrder)) return res.status(400).json({ error: 'Ungültige Reihenfolge.' });
            data.sortOrder = Math.round(sortOrder);
        }

        const saved = await prisma.calendarLabel.update({ where: { id: current.id }, data });
        res.status(200).json(toDto(saved));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/* PUT /calendar/labels/order — { ids: [...] } die ganze Reihenfolge auf einmal.
   Steht VOR '/:id' waere es ein Unterweg davon; als eigener Pfad mit anderem
   Verb kollidiert es nicht. */
router.put('/order', requireAuth, requireAnyPermission(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((value: unknown) => String(value ?? '')) : [];
        if (!ids.length) return res.status(400).json({ error: 'Keine Reihenfolge übergeben.' });

        const rows = await prisma.calendarLabel.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
        const known = new Set(rows.map((row) => row.id));
        await prisma.$transaction(
            ids
                .filter((id: string) => known.has(id))
                .map((id: string, index: number) => prisma.calendarLabel.update({
                    where: { id },
                    data: { sortOrder: (index + 1) * 10 },
                })),
        );
        const list = await prisma.calendarLabel.findMany({ where: { tenantId }, orderBy: LABEL_ORDER_BY });
        res.status(200).json(list.map(toDto));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/* DELETE /calendar/labels/:id — ENDGUELTIG. Der gewoehnliche Weg ist das
   AUSBLENDEN (PATCH { hidden: true }): dabei geht nichts verloren und das
   Etikett kommt ueber das «+» zurueck. Hier verschwindet es wirklich;
   Eintraege, die es tragen, bleiben stehen und sind danach ohne Etikett (der
   Fremdschluessel raeumt selbst auf, ON DELETE SET NULL). `?force=true`
   bestaetigt das, wenn es noch irgendwo klebt. */
router.delete('/:id', requireAuth, requireAnyPermission(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const current = await prisma.calendarLabel.findFirst({ where: { id: String(req.params.id), tenantId } });
        if (!current) return res.status(404).json({ error: 'Etikett nicht gefunden.' });

        if (String(req.query.force ?? '') !== 'true') {
            const inUse = await usageCount(tenantId, current.id);
            if (inUse > 0) {
                return res.status(409).json({
                    error: `Das Etikett «${current.name}» steht auf ${inUse} Eintrag/Einträgen. Diese bleiben erhalten und sind danach ohne Etikett.`,
                    inUse,
                });
            }
        }

        await prisma.calendarLabel.delete({ where: { id: current.id } });
        res.status(204).end();
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
