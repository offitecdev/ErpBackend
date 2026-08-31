"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueLeaveRequestNotice = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const MailDispatchService_1 = require("./outlook/MailDispatchService");
const calendarInviteMail_1 = require("./calendarInviteMail");
const mailBrand_1 = require("./mailBrand");
const mailKindIcons_1 = require("./mailKindIcons");
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
const personnel_1 = require("../../shared/personnel");
/**
 * ANTRAG → MELDUNG UND MAIL (26.08.2026, Vorgabe Samet).
 *
 *   «Wird ein Urlaubsantrag gestellt, erscheint im Kopf neben dem Zeichen ein
 *    farbiger Punkt und es geht eine direkte Meldung raus; gleichzeitig wird
 *    eine Mail an ALLE Personen mit dieser Rolle geschickt — zuerst an die
 *    Verwaltung, danach an die Buchhaltung.»
 *
 * WER WANN POST BEKOMMT:
 *
 *   MANAGER     beim Einreichen. Empfänger sind ALLE mit der Personalrolle
 *               ADMIN — nicht nur die im Antrag gewählte Person. Ist die
 *               Verwaltung zu zweit, soll der Antrag nicht liegen bleiben,
 *               weil eine davon in den Ferien ist.
 *   ACCOUNTING  wenn die Verwaltung freigegeben und damit weitergereicht hat.
 *               Empfänger sind alle mit der Personalrolle ACCOUNTANT. Vorher
 *               erfährt die Buchhaltung von einem Antrag NICHTS.
 *   DECIDED     an die antragstellende Person, sobald der Antrag endgültig
 *               bewilligt oder abgelehnt ist.
 *
 * DIE MELDUNG IST DAS WICHTIGERE. Sie steht in `Notification` und wird auch
 * dann geschrieben, wenn kein Mailserver eingerichtet ist — der farbige Punkt
 * im Kopf hängt an ihr, nicht am SMTP-Server.
 *
 * FEUERN UND VERGESSEN: ein stummer Mailserver darf das Einreichen eines
 * Antrags nicht scheitern lassen.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
/** Die Beschriftung der Antragsart auf Karte und Meldung (Haussprache). */
const REQUEST_TYPE_WORDS = {
    VACATION: "Urlaub",
    REMOTE: "Homeoffice",
    SICK: "Krankheit",
    OTHER: "Sonstiger Antrag",
};
const STATUS_WORDS = {
    PENDING_MANAGER: "Wartet auf Freigabe",
    // Beim Purser: die erste Stufe ist genommen (Vorgabe 27.08.2026 — der
    // Stand heisst «Vom Manager genehmigt», nicht «bei der Buchhaltung»).
    PENDING_ACCOUNTING: "Vom Manager genehmigt",
    APPROVED: "Bewilligt",
    REJECTED: "Abgelehnt",
};
const dayText = (date) => `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;
const loadRequest = (requestId) => prisma_client_1.default.staffLeaveRequest.findUnique({
    where: { id: requestId },
    select: {
        id: true,
        tenantId: true,
        kind: true,
        leaveType: true,
        leaveTypeLabel: true,
        startDate: true,
        endDate: true,
        totalDays: true,
        note: true,
        status: true,
        approverId: true,
        employeeId: true,
        employee: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
});
/**
 * Die Empfängerinnen einer Stufe. Die antragstellende Person ist IMMER
 * ausgenommen (ausser bei DECIDED, wo sie die einzige ist): eine Mail über den
 * eigenen, gerade abgeschickten Antrag ist nur Lärm.
 */
const recipientsFor = async (request, stage) => {
    if (stage === "DECIDED") {
        const person = request.employee;
        if (!person)
            return [];
        return [{
                id: person.id,
                email: clean(person.email).toLowerCase(),
                name: `${person.firstName} ${person.lastName}`.trim(),
            }];
    }
    /* Nur die Firma des Antrags: die Verwaltung einer Schwesterfirma hat mit
       den Ferien dieser Person nichts zu tun und darf sie auch nicht sehen.
       Die im Antrag GEWÄHLTE freigebende Person kommt unten ohnehin dazu. */
    const tenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(request.tenantId);
    /* SEIT DEM 27.08.2026 ENTSCHEIDEN ROLLEN AUS DEN EINSTELLUNGEN, nicht mehr
       die Personalrollen: die erste Stufe geht an die Administratorrolle, die
       zweite an die Purser-Rolle (Role.isPurser). */
    const rows = await prisma_client_1.default.employee.findMany({
        where: {
            ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds.length ? tenantIds : [request.tenantId]),
            deletedAt: null,
            isActive: true,
            employeeRoles: {
                some: { role: stage === "MANAGER" ? { isSystemAdmin: true } : { isPurser: true } },
            },
        },
        select: { id: true, firstName: true, lastName: true, email: true },
    });
    /* Die im Antrag GEWÄHLTE freigebende Person gehört immer dazu — auch wenn
       sie keine Administratorrolle trägt (etwa die Projektleitung). Sonst
       bekäme genau die Person keine Nachricht, die entscheiden muss. */
    if (stage === "MANAGER" && !rows.some((row) => row.id === request.approverId)) {
        const approver = await prisma_client_1.default.employee.findUnique({
            where: { id: request.approverId },
            select: { id: true, firstName: true, lastName: true, email: true },
        });
        if (approver)
            rows.push(approver);
    }
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        if (row.id === request.employeeId)
            continue;
        const email = clean(row.email).toLowerCase();
        if (seen.has(row.id))
            continue;
        seen.add(row.id);
        out.push({ id: row.id, email, name: `${row.firstName} ${row.lastName}`.trim() });
    }
    return out;
};
/** Der Betreff und der erste Satz der Karte, je Stufe. */
const wordsFor = (request, stage) => {
    const requestType = (0, personnel_1.requestTypeOf)(request.kind, request.leaveType);
    const typeWord = REQUEST_TYPE_WORDS[requestType];
    const requester = request.employee
        ? `${request.employee.firstName} ${request.employee.lastName}`.trim()
        : "";
    const period = `${dayText(new Date(request.startDate))} – ${dayText(new Date(request.endDate))}`;
    if (stage === "DECIDED") {
        const approved = request.status === "APPROVED";
        return {
            subject: `${typeWord} ${approved ? "bewilligt" : "abgelehnt"}: ${period}`,
            summary: `${typeWord} ${approved ? "bewilligt" : "abgelehnt"}`,
            requester,
            typeWord,
            period,
        };
    }
    if (stage === "ACCOUNTING") {
        return {
            subject: `Antrag zur Buchung: ${typeWord} — ${requester}`,
            summary: `${typeWord} zur Buchung`,
            requester,
            typeWord,
            period,
        };
    }
    return {
        subject: `Neuer Antrag: ${typeWord} — ${requester}`,
        summary: `${typeWord} — Antrag von ${requester}`,
        requester,
        typeWord,
        period,
    };
};
/** Wohin die Meldung im Programm führt. */
const linkFor = (stage, requestId) => stage === "DECIDED"
    ? `/personnel/requests?tab=mine&focus=${requestId}`
    : `/personnel/requests?tab=incoming&focus=${requestId}`;
/** Eine Antragsmail an EINE Person. */
const sendOne = async (request, recipient, stage) => {
    if (!recipient.email || !EMAIL_RE.test(recipient.email))
        return false;
    const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(request.tenantId) } });
    if (!settings?.smtpHost?.trim() || !settings?.smtpPort)
        return false;
    const fromEmail = clean(settings.fromEmail);
    if (!EMAIL_RE.test(fromEmail))
        return false;
    if (recipient.email.toLowerCase() === fromEmail.toLowerCase())
        return false;
    const words = wordsFor(request, stage);
    const fromName = (0, calendarInviteMail_1.inviteWords)("de").brand;
    const details = [
        stage === "DECIDED" ? null : { label: "Antragsteller", value: words.requester },
        { label: "Art", value: request.leaveTypeLabel?.trim() || words.typeWord },
        { label: "Zeitraum", value: words.period },
        { label: "Arbeitstage", value: String(request.totalDays) },
        { label: "Stand", value: STATUS_WORDS[request.status] || request.status },
    ].filter((row) => row !== null);
    const card = {
        /* Die grüne Karte mit dem Haken — dieselbe wie bei einer zugeteilten
           Aufgabe. Ein Antrag ist wie sie etwas, das JEMAND ERLEDIGEN MUSS,
           und wie sie KEIN Kalendereintrag: er reist ohne iCalendar und ohne
           ICS, sonst stünde er als ganztägiger Termin in Outlook. */
        kind: "TASK",
        method: "REQUEST",
        sequence: 0,
        audience: "TEAM",
        start: new Date(request.startDate),
        end: new Date(request.endDate),
        summary: words.summary,
        location: null,
        details,
        notes: clean(request.note) || null,
        message: null,
        senderName: fromName,
        greetingName: recipient.name || null,
    };
    await (0, MailDispatchService_1.dispatchMail)({ tenantId: request.tenantId, employeeId: request.employeeId }, settings, {
        fromEmail,
        fromName,
        to: recipient.email,
        cc: [],
        subject: words.subject,
        text: (0, calendarInviteMail_1.buildInviteText)(card),
        html: (0, calendarInviteMail_1.buildInviteHtml)(card),
        replyTo: settings.replyTo || null,
        inlineImages: [(0, mailBrand_1.brandLogoInline)(), (0, mailBrand_1.brandWaveInline)(), (0, mailKindIcons_1.kindIconInline)("TASK")],
    }, 
    // Interne Post — sie gehört nicht in den Schriftverkehr eines Kunden.
    { record: null });
    return true;
};
/**
 * MELDUNG + MAIL für eine Stufe des Antragsweges (feuern und vergessen).
 *
 * Die Meldungen werden ZUERST geschrieben und in EINER Anweisung: sie sind das,
 * woran der Punkt im Kopf hängt, und sie dürfen nicht davon abhängen, ob ein
 * Mailserver antwortet.
 */
const queueLeaveRequestNotice = (requestId, stage) => {
    void (async () => {
        const request = await loadRequest(requestId);
        if (!request)
            return;
        const recipients = await recipientsFor(request, stage);
        if (!recipients.length)
            return;
        const words = wordsFor(request, stage);
        const linkUrl = linkFor(stage, request.id);
        await prisma_client_1.default.notification.createMany({
            data: recipients.map((recipient) => ({
                id: (0, nanoid_1.nanoid)(12),
                tenantId: request.tenantId,
                recipientEmployeeId: recipient.id,
                type: "STAFF_REQUEST",
                title: words.subject,
                message: `${words.typeWord} · ${words.period} · ${request.totalDays} Arbeitstage`,
                linkUrl,
                metadata: { requestId: request.id, stage, status: request.status },
            })),
        }).catch((error) => {
            console.error("[ANTRAG] Meldung konnte nicht geschrieben werden:", error?.message || error);
        });
        for (const recipient of recipients) {
            await sendOne(request, recipient, stage).catch((error) => {
                console.error(`[ANTRAG] Mail an ${recipient.email} fehlgeschlagen:`, error?.message || error);
                return false;
            });
        }
    })().catch((error) => console.error(`[ANTRAG] Benachrichtigung ${requestId} fehlgeschlagen:`, error?.message || error));
};
exports.queueLeaveRequestNotice = queueLeaveRequestNotice;
//# sourceMappingURL=leaveRequestMailService.js.map