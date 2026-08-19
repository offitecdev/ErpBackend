"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const calendarMailService_1 = require("../../infrastructure/services/calendarMailService");
/* Workspace "meeting activities" (meetings & lightweight tasks) shown on the CRM
   overview and the unified calendar. Participants mix staff and customers. */
const router = (0, express_1.Router)();
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
const sanitizeCcEmails = (raw) => {
    const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const out = [];
    for (const value of values) {
        const email = String(value ?? '').trim();
        if (!email || !email.includes('@') || out.includes(email))
            continue;
        out.push(email);
    }
    return out;
};
// Normalise + validate the participants payload; throws on malformed rows.
const sanitizeParticipants = (raw) => {
    if (!Array.isArray(raw))
        return [];
    return raw.map((row) => {
        const participantType = row?.participantType === 'CUSTOMER' ? 'CUSTOMER' : row?.participantType === 'EMPLOYEE' ? 'EMPLOYEE' : null;
        if (!participantType)
            throw new Error('participantType EMPLOYEE veya CUSTOMER olmalıdır.');
        const employeeId = participantType === 'EMPLOYEE' ? String(row?.employeeId || '') : '';
        const customerId = participantType === 'CUSTOMER' ? String(row?.customerId || '') : '';
        if (participantType === 'EMPLOYEE' && !employeeId)
            throw new Error('Personel katılımcı için employeeId gerekli.');
        if (participantType === 'CUSTOMER' && !customerId)
            throw new Error('Müşteri katılımcı için customerId gerekli.');
        return {
            participantType,
            employeeId: employeeId || null,
            customerId: customerId || null,
        };
    });
};
// GET /meetings?start=ISO&end=ISO — every activity of the tenant in the range.
router.get('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const start = req.query.start ? new Date(String(req.query.start)) : null;
        const end = req.query.end ? new Date(String(req.query.end)) : null;
        const meetings = await prisma_client_1.default.meetingActivity.findMany({
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
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// POST /meetings — { kind, title, notes?, startTime, endTime, customerId?, participants: [] }
router.post('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const { title, notes, customerId } = req.body || {};
        if (!title || !String(title).trim())
            return res.status(400).json({ error: 'Başlık gerekli.' });
        const startTime = new Date(String(req.body?.startTime || ''));
        const endTime = new Date(String(req.body?.endTime || ''));
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
            return res.status(400).json({ error: 'Geçerli başlangıç ve bitiş zamanı gerekli.' });
        }
        if (endTime <= startTime)
            return res.status(400).json({ error: 'Bitiş zamanı başlangıçtan sonra olmalıdır.' });
        const kind = req.body?.kind === 'TASK' ? 'TASK' : 'MEETING';
        const participants = sanitizeParticipants(req.body?.participants);
        const meeting = await prisma_client_1.default.meetingActivity.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: user.tenantId,
                kind,
                title: String(title).trim(),
                notes: notes ? String(notes) : null,
                startTime,
                endTime,
                ccEmails: sanitizeCcEmails(req.body?.ccEmails),
                customerId: customerId ? String(customerId) : null,
                createdByEmployeeId: user.id,
                participants: {
                    create: participants.map((p) => ({ id: (0, nanoid_1.nanoid)(12), ...p })),
                },
            },
            include: PARTICIPANT_INCLUDE,
        });
        /* WIE BEIM PROJEKTTERMIN (19.08.2026, Vorgabe Samet): die AUFBIETUNG
           der eigenen Leute geht beim Anlegen von selbst raus — an die
           teilnehmenden Mitarbeitenden, die CC-Liste und die Person, die die
           Besprechung angesetzt hat. Der KUNDE erfährt weiterhin erst über
           «Besprechung senden» davon. Aufgaben laden niemanden ein. */
        if (kind === 'MEETING')
            (0, calendarMailService_1.queueMeetingTeamInvite)(meeting.id, user.id);
        res.status(201).json(meeting);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// PATCH /meetings/:id — partial update; a `participants` array replaces the list.
router.patch('/:id', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const existing = await prisma_client_1.default.meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
        });
        if (!existing)
            return res.status(404).json({ error: 'Aktivite bulunamadı.' });
        const data = {};
        if (req.body?.title !== undefined)
            data.title = String(req.body.title).trim();
        if (req.body?.notes !== undefined)
            data.notes = req.body.notes ? String(req.body.notes) : null;
        if (req.body?.kind !== undefined)
            data.kind = req.body.kind === 'TASK' ? 'TASK' : 'MEETING';
        if (req.body?.customerId !== undefined)
            data.customerId = req.body.customerId ? String(req.body.customerId) : null;
        if (req.body?.ccEmails !== undefined)
            data.ccEmails = sanitizeCcEmails(req.body.ccEmails);
        if (req.body?.startTime !== undefined) {
            const startTime = new Date(String(req.body.startTime));
            if (Number.isNaN(startTime.getTime()))
                return res.status(400).json({ error: 'Geçersiz başlangıç zamanı.' });
            data.startTime = startTime;
        }
        if (req.body?.endTime !== undefined) {
            const endTime = new Date(String(req.body.endTime));
            if (Number.isNaN(endTime.getTime()))
                return res.status(400).json({ error: 'Geçersiz bitiş zamanı.' });
            data.endTime = endTime;
        }
        const participants = req.body?.participants !== undefined ? sanitizeParticipants(req.body.participants) : null;
        const meeting = await prisma_client_1.default.meetingActivity.update({
            where: { id: existing.id },
            data: {
                ...data,
                ...(participants !== null
                    ? {
                        participants: {
                            deleteMany: {},
                            create: participants.map((p) => ({ id: (0, nanoid_1.nanoid)(12), ...p })),
                        },
                    }
                    : {}),
            },
            include: PARTICIPANT_INCLUDE,
        });
        res.status(200).json(meeting);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// DELETE /meetings/:id
router.delete('/:id', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const existing = await prisma_client_1.default.meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
        });
        if (!existing)
            return res.status(404).json({ error: 'Aktivite bulunamadı.' });
        const cancellation = await (0, calendarMailService_1.buildMeetingCancellation)(existing.id);
        await prisma_client_1.default.meetingActivity.delete({ where: { id: existing.id } });
        (0, calendarMailService_1.queueMeetingCancellation)(cancellation, user.id);
        res.status(200).json({ message: 'Aktivite silindi.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/* POST /meetings/:id/send-invite — «Besprechung senden»: EIN Klick, ZWEI
   Nachrichten (Kunde und Team), genau wie beim Projekttermin. Der Dienst wirft,
   wenn keine der beiden rausgehen konnte; der Fehlertext steht dann schon
   darin. */
router.post('/:id/send-invite', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const existing = await prisma_client_1.default.meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Aktivite bulunamadı.' });
        const cc = Array.isArray(req.body?.cc) ? req.body.cc.map((value) => String(value ?? '')) : [];
        const result = await (0, calendarMailService_1.sendMeetingInvite)(existing.id, user.id, {
            to: String(req.body?.to ?? ''),
            cc,
            subject: req.body?.subject ? String(req.body.subject) : null,
            message: req.body?.message ? String(req.body.message) : null,
            teamMail: req.body?.teamMail !== false,
        });
        res.status(200).json(result);
    }
    catch (error) {
        res.status(error?.status || 400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=meeting.routes.js.map