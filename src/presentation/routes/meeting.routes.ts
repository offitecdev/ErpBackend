import { Router } from 'express';
import { nanoid } from 'nanoid';
import { requireAuth } from '../middlewares/AuthMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { resolveNewLabelId, sanitizeLabelId } from '../../application/services/calendarLabelCatalog';
import {
    buildMeetingCancellation,
    queueMeetingCancellation,
    queueMeetingTeamInvite,
    sendMeetingInvite,
} from '../../infrastructure/services/calendarMailService';

/* Workspace "meeting activities" (meetings & lightweight tasks) shown on the CRM
   overview and the unified calendar. Participants mix staff and customers. */

const router = Router();

type ParticipantInput = { participantType: 'EMPLOYEE' | 'CUSTOMER'; employeeId?: string | null; customerId?: string | null };

const PARTICIPANT_INCLUDE = {
    participants: {
        include: {
            employee: { select: { id: true, firstName: true, lastName: true, email: true, roleName: true } },
            customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
        },
    },
    // mainEmail: the To of «Besprechung senden» in the calendar detail popup.
    customer: { select: { id: true, companyName: true, mainEmail: true } },
    createdBy: { select: { id: true, firstName: true, lastName: true } },
};

// CC listesi: dizi ya da virgüllü tek satır kabul edilir; boşlar ve
// yinelenenler ayıklanır, adres kabaca doğrulanır (bir '@' içermeli).
const sanitizeCcEmails = (raw: unknown): string[] => {
    const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const out: string[] = [];
    for (const value of values) {
        const email = String(value ?? '').trim();
        if (!email || !email.includes('@') || out.includes(email)) continue;
        out.push(email);
    }
    return out;
};

// Normalise + validate the participants payload; throws on malformed rows.
const sanitizeParticipants = (raw: unknown): ParticipantInput[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map((row: any) => {
        const participantType = row?.participantType === 'CUSTOMER' ? 'CUSTOMER' : row?.participantType === 'EMPLOYEE' ? 'EMPLOYEE' : null;
        if (!participantType) throw new Error('participantType EMPLOYEE veya CUSTOMER olmalıdır.');
        const employeeId = participantType === 'EMPLOYEE' ? String(row?.employeeId || '') : '';
        const customerId = participantType === 'CUSTOMER' ? String(row?.customerId || '') : '';
        if (participantType === 'EMPLOYEE' && !employeeId) throw new Error('Personel katılımcı için employeeId gerekli.');
        if (participantType === 'CUSTOMER' && !customerId) throw new Error('Müşteri katılımcı için customerId gerekli.');
        return {
            participantType,
            employeeId: employeeId || null,
            customerId: customerId || null,
        } as ParticipantInput;
    });
};

// GET /meetings?start=ISO&end=ISO — every activity of the tenant in the range.
router.get('/', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const start = req.query.start ? new Date(String(req.query.start)) : null;
        const end = req.query.end ? new Date(String(req.query.end)) : null;
        const meetings = await (prisma as any).meetingActivity.findMany({
            where: {
                tenantId: user.tenantId,
                ...(start && !Number.isNaN(start.getTime()) ? { startTime: { gte: start } } : {}),
                ...(end && !Number.isNaN(end.getTime()) ? { AND: [{ startTime: { lte: end } }] } : {}),
            },
            include: PARTICIPANT_INCLUDE,
            orderBy: { startTime: 'asc' },
            take: 500,
        });
        res.status(200).json(meetings);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// POST /meetings — { kind, title, notes?, startTime, endTime, customerId?, participants: [] }
router.post('/', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const { title, notes, customerId } = req.body || {};
        if (!title || !String(title).trim()) return res.status(400).json({ error: 'Başlık gerekli.' });
        const startTime = new Date(String(req.body?.startTime || ''));
        const endTime = new Date(String(req.body?.endTime || ''));
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
            return res.status(400).json({ error: 'Geçerli başlangıç ve bitiş zamanı gerekli.' });
        }
        if (endTime <= startTime) return res.status(400).json({ error: 'Bitiş zamanı başlangıçtan sonra olmalıdır.' });
        const kind = req.body?.kind === 'TASK' ? 'TASK' : 'MEETING';
        const participants = sanitizeParticipants(req.body?.participants);
        /* KALENDER-ETIKETT (25.08.2026). Ohne Auswahl greift der Vorschlag der
           Rolle «Besprechung»; ist die Liste leer, bleibt der Eintrag ohne
           Etikett. Eine Aufgabe bekommt gar keinen Vorschlag -- sie steht
           nicht mehr im Raster. */
        const labelId = kind === 'TASK'
            ? (await sanitizeLabelId(user.tenantId, req.body?.labelId)) ?? null
            : await resolveNewLabelId(user.tenantId, req.body?.labelId, 'MEETING');

        const meeting = await (prisma as any).meetingActivity.create({
            data: {
                id: nanoid(12),
                tenantId: user.tenantId,
                kind,
                labelId,
                title: String(title).trim(),
                notes: notes ? String(notes) : null,
                startTime,
                endTime,
                ccEmails: sanitizeCcEmails(req.body?.ccEmails),
                customerId: customerId ? String(customerId) : null,
                createdByEmployeeId: user.id,
                participants: {
                    create: participants.map((p) => ({ id: nanoid(12), ...p })),
                },
            },
            include: PARTICIPANT_INCLUDE,
        });
        /* WIE BEIM PROJEKTTERMIN (19.08.2026, Vorgabe Samet): die AUFBIETUNG
           der eigenen Leute geht beim Anlegen von selbst raus — an die
           teilnehmenden Mitarbeitenden, die CC-Liste und die Person, die die
           Besprechung angesetzt hat. Der KUNDE erfährt weiterhin erst über
           «Besprechung senden» davon. Aufgaben laden niemanden ein. */
        if (kind === 'MEETING') queueMeetingTeamInvite(meeting.id, user.id);
        res.status(201).json(meeting);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// PATCH /meetings/:id — partial update; a `participants` array replaces the list.
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const existing = await (prisma as any).meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
        });
        if (!existing) return res.status(404).json({ error: 'Aktivite bulunamadı.' });
        /* AUS DER MAIL ⇒ NICHT VON HAND (21.08.2026). Ein Termin mit
           `externalOrigin` gehört dem Organisator in Outlook/Teams: er wird bei
           jeder neuen Fassung der Einladung nachgeführt. Eine Änderung hier
           wäre beim nächsten Abruf spurlos verschwunden — dann lieber gleich
           sagen, dass sie nicht zählt. */
        if (existing.externalOrigin) {
            return res.status(409).json({
                code: 'EXTERNAL_MEETING',
                error: 'Dieser Termin kommt aus Outlook/Teams und wird von dort aktualisiert.',
            });
        }

        const data: Record<string, unknown> = {};
        if (req.body?.title !== undefined) data.title = String(req.body.title).trim();
        if (req.body?.notes !== undefined) data.notes = req.body.notes ? String(req.body.notes) : null;
        if (req.body?.kind !== undefined) data.kind = req.body.kind === 'TASK' ? 'TASK' : 'MEETING';
        if (req.body?.customerId !== undefined) data.customerId = req.body.customerId ? String(req.body.customerId) : null;
        if (req.body?.labelId !== undefined) data.labelId = await sanitizeLabelId(user.tenantId, req.body.labelId) ?? null;
        if (req.body?.ccEmails !== undefined) data.ccEmails = sanitizeCcEmails(req.body.ccEmails);
        if (req.body?.startTime !== undefined) {
            const startTime = new Date(String(req.body.startTime));
            if (Number.isNaN(startTime.getTime())) return res.status(400).json({ error: 'Geçersiz başlangıç zamanı.' });
            data.startTime = startTime;
        }
        if (req.body?.endTime !== undefined) {
            const endTime = new Date(String(req.body.endTime));
            if (Number.isNaN(endTime.getTime())) return res.status(400).json({ error: 'Geçersiz bitiş zamanı.' });
            data.endTime = endTime;
        }

        const participants = req.body?.participants !== undefined ? sanitizeParticipants(req.body.participants) : null;
        const meeting = await (prisma as any).meetingActivity.update({
            where: { id: existing.id },
            data: {
                ...data,
                ...(participants !== null
                    ? {
                          participants: {
                              deleteMany: {},
                              create: participants.map((p) => ({ id: nanoid(12), ...p })),
                          },
                      }
                    : {}),
            },
            include: PARTICIPANT_INCLUDE,
        });
        res.status(200).json(meeting);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /meetings/:id
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const existing = await (prisma as any).meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
        });
        if (!existing) return res.status(404).json({ error: 'Aktivite bulunamadı.' });
        const cancellation = await buildMeetingCancellation(existing.id);
        await (prisma as any).meetingActivity.delete({ where: { id: existing.id } });
        queueMeetingCancellation(cancellation, user.id);
        res.status(200).json({ message: 'Aktivite silindi.' });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/* POST /meetings/:id/send-invite — «Besprechung senden»: EIN Klick, ZWEI
   Nachrichten (Kunde und Team), genau wie beim Projekttermin. Der Dienst wirft,
   wenn keine der beiden rausgehen konnte; der Fehlertext steht dann schon
   darin. */
router.post('/:id/send-invite', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const existing = await (prisma as any).meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true },
        });
        if (!existing) return res.status(404).json({ error: 'Aktivite bulunamadı.' });
        const cc = Array.isArray(req.body?.cc) ? req.body.cc.map((value: unknown) => String(value ?? '')) : [];
        const result = await sendMeetingInvite(existing.id, user.id, {
            to: String(req.body?.to ?? ''),
            cc,
            subject: req.body?.subject ? String(req.body.subject) : null,
            message: req.body?.message ? String(req.body.message) : null,
            teamMail: req.body?.teamMail !== false,
        });
        res.status(200).json(result);
    } catch (error: any) {
        res.status(error?.status || 400).json({ error: error.message });
    }
});

export default router;
