"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const calendarLabelCatalog_1 = require("../../application/services/calendarLabelCatalog");
const calendarMailService_1 = require("../../infrastructure/services/calendarMailService");
const ImapCaptureService_1 = require("../../infrastructure/services/ImapCaptureService");
const caldavCalendarService_1 = require("../../infrastructure/services/caldavCalendarService");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
/* Workspace "meeting activities" (meetings & lightweight tasks) shown on the CRM
   overview and the unified calendar. Participants mix staff and customers. */
const router = (0, express_1.Router)();
const meetingVisibility = (tenantId, employeeId) => ({ tenantId, employeeId });
const visibleMeetingWhere = (scope) => ({
    OR: [
        { tenantId: scope.tenantId, externalOrigin: null },
        {
            NOT: { externalOrigin: null },
            /* Only the participant link proves personal ownership. Historical
               imports used an arbitrary employee merely to satisfy the
               required createdBy column; using it here would leak old meetings
               until the one-time IMAP backfill repairs them. */
            participants: { some: { employeeId: scope.employeeId } },
        },
    ],
});
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
        const scope = meetingVisibility(user.tenantId, user.id);
        const meetings = await prisma_client_1.default.meetingActivity.findMany({
            where: {
                ...visibleMeetingWhere(scope),
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
        /* KALENDER-ETIKETT (25.08.2026). Ohne Auswahl greift der Vorschlag der
           Rolle «Besprechung»; ist die Liste leer, bleibt der Eintrag ohne
           Etikett. Eine Aufgabe bekommt gar keinen Vorschlag -- sie steht
           nicht mehr im Raster. */
        const labelId = kind === 'TASK'
            ? (await (0, calendarLabelCatalog_1.sanitizeLabelId)(user.tenantId, req.body?.labelId)) ?? null
            : await (0, calendarLabelCatalog_1.resolveNewLabelId)(user.tenantId, req.body?.labelId, 'MEETING');
        const meeting = await prisma_client_1.default.meetingActivity.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
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
        const scope = meetingVisibility(user.tenantId, user.id);
        const existing = await prisma_client_1.default.meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), ...visibleMeetingWhere(scope) },
        });
        if (!existing)
            return res.status(404).json({ error: 'Aktivite bulunamadı.' });
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
        const data = {};
        if (req.body?.title !== undefined)
            data.title = String(req.body.title).trim();
        if (req.body?.notes !== undefined)
            data.notes = req.body.notes ? String(req.body.notes) : null;
        if (req.body?.kind !== undefined)
            data.kind = req.body.kind === 'TASK' ? 'TASK' : 'MEETING';
        if (req.body?.customerId !== undefined)
            data.customerId = req.body.customerId ? String(req.body.customerId) : null;
        if (req.body?.labelId !== undefined)
            data.labelId = await (0, calendarLabelCatalog_1.sanitizeLabelId)(user.tenantId, req.body.labelId) ?? null;
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
        const scope = meetingVisibility(user.tenantId, user.id);
        const existing = await prisma_client_1.default.meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), ...visibleMeetingWhere(scope) },
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
        const scope = meetingVisibility(user.tenantId, user.id);
        const existing = await prisma_client_1.default.meetingActivity.findFirst({
            where: { id: String(req.params.id || ''), ...visibleMeetingWhere(scope) },
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
/* ── DER KALENDER HOLT SICH SEINE TERMINE SELBST ──────────────────────────────
 *
 * Vorgabe 31.08.2026: «und auch, wenn wir den Kalender aufrufen — damit wir
 * dann ebenfalls Daten daraus ziehen können.»
 *
 * Bis hierher war der Kalender rein passiv: Einladungen kamen ausschliesslich
 * über den Zeitplan des Postfachabrufs herein, und wer den Kalender öffnete,
 * sah den Stand des letzten Durchgangs. Ein Termin, den jemand vor fünf Minuten
 * in Outlook angesetzt hat, fehlte — ohne dass man etwas dagegen tun konnte.
 *
 * Jetzt stösst das Öffnen des Kalenders denselben Abruf an. DREI RIEGEL halten
 * das billig und ungefährlich:
 *
 *   1. NUR EINER GLEICHZEITIG. `captureInbox` weist einen zweiten Durchgang
 *      selbst ab; hier wird gar nicht erst einer gestartet. Zwei gleichzeitige
 *      Abrufe schieben denselben Lesestand weiter, und weil nur vorwärts
 *      gelesen wird, ist die übersprungene Post danach still verloren.
 *   2. NICHT ÖFTER ALS NÖTIG. Lag der letzte Durchgang keine Minute zurück,
 *      passiert nichts — sonst löste jeder Wechsel von Monat zu Woche eine
 *      neue IMAP-Sitzung aus.
 *   3. DER KALENDER WARTET NICHT. Nach höchstens acht Sekunden antwortet die
 *      Route, auch wenn der Abruf weiterläuft: der Kalender soll aufgehen,
 *      nicht auf einen Mailserver warten. Was danach noch hereinkommt, steht
 *      beim nächsten Öffnen da.
 *
 * ZWEI QUELLEN, EIN KNOPF (31.08.2026, Samet: «es soll nicht nur aus den
 * Mails ziehen, sondern auch aus dem Outlook-Kalender — aber nur aus dem
 * eigenen Konto»). Angestossen werden beide Wege, jeder mit seinem eigenen
 * Schalter:
 *
 *   POSTFACH  `imapCaptureEnabled` — Einladungen aus Posteingang und Gesendet.
 *   KALENDER  `caldavEnabled` — der Kalender desselben Kontos über CalDAV.
 *             Nur so kommt an, was jemand sich selbst einträgt, ohne jemanden
 *             einzuladen.
 *
 * Ist keiner von beiden an, liest hier niemand etwas — der Kalender bekommt
 * dann nur, was im ERP steht.
 */
const CALENDAR_SYNC_MIN_INTERVAL_MS = 60_000;
const CALENDAR_SYNC_WAIT_MS = 8_000;
router.post('/sync', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const mailTenantId = await (0, serviceTenantScope_1.getMailTenantId)(req.user.tenantId).catch(() => req.user.tenantId);
        const settings = await prisma_client_1.default.mailSetting.findUnique({
            where: { tenantId: mailTenantId },
            select: {
                imapHost: true, imapCaptureEnabled: true, imapLastSyncAt: true,
                caldavEnabled: true, caldavLastSyncAt: true,
            },
        });
        if (!settings?.imapHost?.trim())
            return res.json({ started: false, reason: 'not_configured', calendar: 0 });
        /* Jeder Weg wird für sich geprüft. Vorher hing alles am Postfach-
           schalter; stand der auf aus, blieb auch der Kalender still — obwohl
           er ein eigenes Konto und einen eigenen Schalter hat. */
        const mailDue = Boolean(settings.imapCaptureEnabled) && !(0, ImapCaptureService_1.isCaptureRunning)(mailTenantId);
        const calendarDue = Boolean(settings.caldavEnabled) && !(0, caldavCalendarService_1.isCaldavRunning)(mailTenantId);
        if (!settings.imapCaptureEnabled && !settings.caldavEnabled) {
            return res.json({ started: false, reason: 'disabled', calendar: 0 });
        }
        // Ein laufender Durchgang wird NICHT verdoppelt: zwei gleichzeitige
        // Abrufe schieben denselben Lesestand weiter, und weil nur vorwärts
        // gelesen wird, ist die übersprungene Post danach still verloren.
        if (!mailDue && !calendarDue)
            return res.json({ started: false, reason: 'running', calendar: 0 });
        /* Der Mindestabstand gilt für den zuletzt gelaufenen der beiden Wege —
           sonst löste jeder Wechsel von Monat zu Woche eine neue Sitzung aus. */
        const lastSyncAt = [settings.imapLastSyncAt, settings.caldavLastSyncAt]
            .filter((value) => Boolean(value))
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const sinceLast = lastSyncAt ? Date.now() - lastSyncAt.getTime() : Number.POSITIVE_INFINITY;
        // `?force=1` ist der Knopf «jetzt abrufen» im Kalender; das Öffnen der
        // Seite hält sich an den Mindestabstand.
        if (String(req.query.force || '') !== '1' && sinceLast < CALENDAR_SYNC_MIN_INTERVAL_MS) {
            return res.json({ started: false, reason: 'recent', calendar: 0, lastSyncAt });
        }
        /* Die Abrufe laufen weiter, auch wenn die Antwort schon raus ist — darum
           MUSS der Fehlerfall hier hängen. Ohne das eigene `catch` stürbe der
           Prozess an einer abgelehnten Zusage, die niemand mehr abholt. */
        const jobs = [];
        if (mailDue) {
            jobs.push((0, ImapCaptureService_1.captureInbox)(mailTenantId).then((summary) => summary.calendar).catch((error) => {
                console.error('[KALENDER] Postfachabruf beim Öffnen fehlgeschlagen:', error?.message || error);
                return 0;
            }));
        }
        if (calendarDue) {
            jobs.push((0, caldavCalendarService_1.captureCalendar)(mailTenantId).then((summary) => summary.created + summary.updated).catch((error) => {
                console.error('[KALENDER] Kalenderabruf beim Öffnen fehlgeschlagen:', error?.message || error);
                return 0;
            }));
        }
        const both = Promise.all(jobs).then((counts) => counts.reduce((sum, value) => sum + value, 0));
        const changed = await Promise.race([
            both,
            new Promise((resolve) => setTimeout(() => resolve(null), CALENDAR_SYNC_WAIT_MS)),
        ]);
        res.json({
            started: true,
            // Wie viele Termine die Durchgänge angelegt/geändert haben. `null` =
            // sie liefen noch, als geantwortet wurde.
            calendar: changed ?? 0,
            pending: changed === null,
            lastSyncAt: changed === null ? lastSyncAt : new Date(),
        });
    }
    catch (error) {
        // Ein misslungener Abruf darf den Kalender nicht aufhalten: gemeldet,
        // aber nicht als Fehler der Seite.
        res.json({ started: false, reason: 'error', error: error?.message || 'Abruf fehlgeschlagen.', calendar: 0 });
    }
});
exports.default = router;
//# sourceMappingURL=meeting.routes.js.map