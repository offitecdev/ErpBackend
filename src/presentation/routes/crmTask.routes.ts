import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { taskDocumentStorage } from '../../infrastructure/services/LocalFileStorage';
import { sanitizeDocumentUpload, documentListSelect } from '../controllers/appointmentSeries';
import { sanitizeLabelId } from '../../application/services/calendarLabelCatalog';
import { queueTaskAssignmentMail } from '../../infrastructure/services/taskMailService';
import { flipOverdueTasks } from '../../infrastructure/services/crmTaskMaintenance';
import { GetUserPermissionsUseCase } from '../../application/use-cases/auth/GetUserPermissionsUseCase';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { getPersonnelTenantScope, employeeScopeWhere } from '../controllers/serviceTenantScope';

/* Aufgaben & Erinnerungen (mounted under /crm alongside crm.routes.ts).

   Stand 19.08.2026 — OHNE Freigabe:
     • Eine Aufgabe kann an MEHRERE Personen gehen (CrmTaskAssignee); die
       Altspalte assigneeEmployeeId spiegelt die erste Verantwortliche.
     • Wer eine Aufgabe abhakt, erledigt sie — Punkt. Es gibt KEINEN
       Freigabe-Lauf und keine Freigabe-Benachrichtigungen mehr (Vorgabe
       19.08.2026); geblieben ist die eine Meldung "Ihnen wurde … zugewiesen"
       (TASK_ASSIGNED) an fremde Verantwortliche.
     • Notizen mit Bildern (Daten-URLs wie bei den Rapporten) hängen an der
       Aufgabe; Verantwortliche und Erfassende dürfen sie schreiben.

   Stand 11.09.2026 (Vorgabe Samet) — die Aufgabe wird ein PLAN:
     • ANFANG UND ENDE. `startAt` kommt neben `dueDate`; `dueDate` bleibt das
       ENDE, weil der Verfalldienst, das Erinnerungsläuten und jede
       bestehende Zeile damit rechnen. Eine Aufgabe darf sich über mehrere
       Tage ziehen — die Liste sucht darum ÜBERSCHNEIDUNGEN mit dem Fenster
       und nicht mehr nur den Endtermin darin.
     • ANLEITUNG (CrmTaskStep) und ANHÄNGE (CrmTaskDocument, Bild ODER PDF),
       beide freiwillig: `PUT …/steps` speichert die ganze Liste auf einmal,
       `POST …/documents` nimmt die Dateien roh (multipart) entgegen.
     • MEHRERE Personen und MEHRERE Kunden im Filter (`assigneeIds`,
       `customerIds`); die alten Einzahl-Parameter bleiben gültig.

   Die Oberfläche fragt EINEN Zeitraum ab: `from`/`to` (ISO-Zeitpunkte) grenzen
   `dueDate` ein, Aufgaben OHNE Termin kommen in jedem Zeitraum mit — sie hängen
   an keinem Tag und dürfen darum nie unsichtbar werden.

   Sichten (`scope`), alle auth-only, weil sie nur Beteiligung zeigen:
     • `me` — MIT MIR: ich stehe in den Verantwortlichen (auch selbst zugewiesen)
     • `by` — OHNE MICH: ich habe zugewiesen, bin selbst nicht verantwortlich
     • `mine` — Altwert: beides zusammen (Personalakte, Kundenakte)
   Ohne `scope` ist es die ganze Firma und braucht `crm.customers.view`.

   Rechte: Lesen `crm.customers.view`, Anlegen/Löschen `crm.activities.create`.
   Status, Termin und Notizen sind für BETEILIGTE (verantwortlich oder
   erfassend) auth-only — sonst könnte eine Person ohne CRM-Recht die ihr
   zugeteilte Aufgabe nicht einmal abhaken.

   PERFORMANCE: die Liste ist zwei parallele Raw-Statements plus EIN Nachlade-
   Statement für alle Verantwortlichen der Seite (siehe crm.routes.ts). */

const router = Router();
const permissionsUseCase = new GetUserPermissionsUseCase(new RoleRepository());

const TASK_STATUSES = new Set(['OPEN', 'DONE', 'INCOMPLETE']);
/** Höchstzahl Bilder je Notiz und Grösse einer Daten-URL (~1,5 MB Bild). */
const MAX_NOTE_IMAGES = 6;
const MAX_IMAGE_CHARS = 2_100_000;

const parseJson = (value: unknown): unknown => {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
};

const personOrNull = (id: unknown, first: unknown, last: unknown) =>
    id ? { id: String(id), firstName: String(first ?? ''), lastName: String(last ?? '') } : null;

const parsePage = (req: { query: Record<string, unknown> }) => {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize || '25'), 10) || 25));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

const parseDate = (raw: unknown): Date | null => {
    if (!raw) return null;
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Ein Filterwert, der EINEN oder VIELE trägt (11.09.2026): `?assigneeIds=a,b,c`
 * bzw. eine Liste im Körper. Leer heisst «alle» — ein Filter, dessen
 * Grundzustand «alle» ist, schickt gar nichts.
 */
const parseIdList = (raw: unknown): string[] => {
    const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
};

/**
 * Anfang und Ende in die richtige Reihenfolge (11.09.2026). Wer im Fenster
 * zuerst das Ende und dann einen späteren Anfang wählt, meint keine leere
 * Spanne — er hat die Felder in der anderen Reihenfolge ausgefüllt. Getauscht
 * statt abgewiesen, wie es der Zeitraumfilter der Liste auch tut.
 */
const orderSpan = (startAt: Date | null, dueDate: Date | null): { startAt: Date | null; dueDate: Date | null } => {
    if (startAt && dueDate && startAt.getTime() > dueDate.getTime()) return { startAt: dueDate, dueDate: startAt };
    return { startAt, dueDate };
};

/** Höchstzahl Schritte je Anleitung und Zeichen je Schritt. */
const MAX_STEPS = 40;
const MAX_STEP_CHARS = 500;

/**
 * Die Anleitung, wie sie aus der Oberfläche kommt: eine Liste von Zeilen,
 * jede mit Text und Häkchen. Die Reihenfolge ist die der Liste — `position`
 * wird beim Speichern neu vergeben, damit Einfügen und Streichen keine Lücken
 * hinterlassen.
 */
const parseSteps = (raw: unknown): Array<{ text: string; done: boolean }> | undefined => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((row: any) => ({
            text: String(row?.text ?? row ?? '').trim().slice(0, MAX_STEP_CHARS),
            done: Boolean(row?.done),
        }))
        .filter((step) => step.text.length > 0)
        .slice(0, MAX_STEPS);
};

/** Schritte einer Aufgabe ersetzen — EINE Transaktion, Reihenfolge = Listenfolge. */
const replaceSteps = async (taskId: string, steps: Array<{ text: string; done: boolean }>) => {
    await prisma.$transaction([
        prisma.crmTaskStep.deleteMany({ where: { taskId } }),
        ...(steps.length
            ? [prisma.crmTaskStep.createMany({
                data: steps.map((step, index) => ({
                    id: nanoid(12),
                    taskId,
                    position: index,
                    text: step.text,
                    done: step.done,
                })),
            })]
            : []),
    ]);
};

const stepRow = (step: { id: string; position: number; text: string; done: boolean }) => ({
    id: step.id,
    position: step.position,
    text: step.text,
    done: step.done,
});

/** Verantwortliche aus dem Body: `assigneeEmployeeIds` (Liste) oder die alte Einzahl. */
const parseAssigneeIds = (body: any): string[] | undefined => {
    if (Array.isArray(body?.assigneeEmployeeIds)) {
        return [...new Set(body.assigneeEmployeeIds.map((id: unknown) => String(id || '').trim()).filter(Boolean))] as string[];
    }
    if (body?.assigneeEmployeeId !== undefined) {
        const single = String(body.assigneeEmployeeId || '').trim();
        return single ? [single] : [];
    }
    return undefined;
};

const hasPermission = async (userId: string, permission: string): Promise<boolean> => {
    const list = await permissionsUseCase.execute(userId).catch(() => [] as string[]);
    return list.includes(permission);
};

type TaskCore = {
    id: string;
    tenantId: string;
    kind: string;
    title: string;
    status: string;
    createdByEmployeeId: string;
    assigneeEmployeeId: string | null;
    customerId: string | null;
    assignees: Array<{ employeeId: string }>;
};

const loadTaskCore = (id: string, tenantId: string) =>
    prisma.crmTask.findFirst({
        where: { id, tenantId },
        select: {
            id: true, tenantId: true, kind: true, title: true, status: true,
            createdByEmployeeId: true, assigneeEmployeeId: true, customerId: true,
            assignees: { select: { employeeId: true } },
        },
    }) as Promise<TaskCore | null>;

const isAssignee = (task: TaskCore, userId: string) =>
    task.assigneeEmployeeId === userId || task.assignees.some((row) => row.employeeId === userId);
const isParticipant = (task: TaskCore, userId: string) =>
    task.createdByEmployeeId === userId || isAssignee(task, userId);

/**
 * Abhaken und Umterminieren in EINER Anweisung.
 *
 * Das Abhaken ist der häufigste Griff der Oberfläche und setzt genau eine
 * Spalte — es darf nicht vier Runden zur entfernten Datenbank kosten (Laden,
 * Verantwortliche, Rechte, Schreiben ≈ 600–900 ms). Die Rechteprüfung steht
 * darum IM `WHERE`: nur Beteiligte (erfassend oder verantwortlich) treffen die
 * Zeile. Trifft sie keine, gibt die Funktion `null` zurück und der Aufrufer
 * geht den ausführlichen Weg — der beantwortet dann sauber 404 bzw. 403 und
 * lässt Verwaltungsrechte durch.
 *
 * Rückgabe ist die Kurzform, die die Oberfläche liest (Status, Termin,
 * Erledigt-Stempel); `updatedAt` wird von Hand gesetzt, weil Prismas
 * `@updatedAt` bei einer Rohanweisung nicht greift.
 */
const fastPatchStatus = async (
    id: string,
    tenantId: string,
    userId: string,
    body: any,
): Promise<{ id: string; status?: string; completedAt: Date | null; startAt?: Date | null; dueDate?: Date | null; allDay?: boolean } | 'BAD_STATUS' | null> => {
    const sets: Prisma.Sql[] = [Prisma.sql`tk.updatedAt = NOW(3)`];
    let status: string | undefined;
    let completedAt: Date | null = null;
    let startAt: Date | null | undefined;
    let dueDate: Date | null | undefined;
    let allDay: boolean | undefined;

    if (body?.status !== undefined) {
        status = String(body.status).trim().toUpperCase();
        if (!TASK_STATUSES.has(status)) return 'BAD_STATUS';
        completedAt = status === 'DONE' ? new Date() : null;
        sets.push(Prisma.sql`tk.status = ${status}`, Prisma.sql`tk.completedAt = ${completedAt}`);
    }
    /* Kommen Anfang UND Ende zusammen, werden sie hier getauscht, falls sie
       verdreht sind — dasselbe wie im ausführlichen Weg. Kommt nur eines,
       bleibt das andere stehen; der Vergleich gegen den gespeicherten Wert
       gehört dem ausführlichen Weg, denn dafür müsste hier erst gelesen
       werden, und das ist genau die Runde, die dieser Weg spart. */
    if (body?.startAt !== undefined && body?.dueDate !== undefined) {
        const span = orderSpan(parseDate(body.startAt), parseDate(body.dueDate));
        startAt = span.startAt;
        dueDate = span.dueDate;
    } else {
        if (body?.startAt !== undefined) startAt = parseDate(body.startAt);
        if (body?.dueDate !== undefined) dueDate = parseDate(body.dueDate);
    }
    if (startAt !== undefined) sets.push(Prisma.sql`tk.startAt = ${startAt}`);
    if (dueDate !== undefined) sets.push(Prisma.sql`tk.dueDate = ${dueDate}`);
    if (body?.allDay !== undefined) {
        allDay = Boolean(body.allDay);
        sets.push(Prisma.sql`tk.allDay = ${allDay}`);
    }

    const affected = await prisma.$executeRaw(Prisma.sql`
        UPDATE CrmTask tk
           SET ${Prisma.join(sets, ', ')}
         WHERE tk.id = ${id}
           AND tk.tenantId = ${tenantId}
           AND (tk.createdByEmployeeId = ${userId}
                OR tk.assigneeEmployeeId = ${userId}
                OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = tk.id AND ta.employeeId = ${userId}))
    `);
    if (!affected) return null;
    return {
        id,
        ...(status ? { status } : {}),
        completedAt,
        ...(startAt !== undefined ? { startAt } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(allDay !== undefined ? { allDay } : {}),
    };
};

/** Personen der Firma prüfen und die Verantwortlichen-Zeilen neu setzen.
    Der Mandant gehört zur Prüfung: sonst liesse sich eine Aufgabe mit einer
    von Hand gesetzten Id an eine Person der Schwesterfirma hängen — genau die
    Vermischung, die es seit dem 31.08.2026 nicht mehr geben darf. */
const validateEmployees = async (ids: string[], tenantId: string) => {
    if (ids.length === 0) return [] as string[];
    const rows = await prisma.employee.findMany({
        where: { id: { in: ids }, ...employeeScopeWhere(await getPersonnelTenantScope(tenantId)) },
        select: { id: true },
    });
    const found = new Set(rows.map((row) => row.id));
    return ids.filter((id) => found.has(id));
};

const replaceAssignees = async (taskId: string, ids: string[]) => {
    await prisma.$transaction([
        prisma.crmTaskAssignee.deleteMany({ where: { taskId, employeeId: { notIn: ids.length ? ids : ['__none__'] } } }),
        ...ids.map((employeeId) => prisma.crmTaskAssignee.upsert({
            where: { taskId_employeeId: { taskId, employeeId } },
            update: {},
            create: { id: nanoid(12), taskId, employeeId },
        })),
        prisma.crmTask.update({ where: { id: taskId }, data: { assigneeEmployeeId: ids[0] ?? null } }),
    ]);
};

const actorName = async (userId: string) => {
    const person = await prisma.employee.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return `${person?.firstName || ''} ${person?.lastName || ''}`.trim();
};

/**
 * "Ihnen wurde … zugewiesen" je Empfänger; sprachneutral über metadata.i18n
 * (lib/notificationText.ts). Die EINZIGE Aufgaben-Benachrichtigung — mit dem
 * Freigabe-Lauf sind TASK_APPROVAL/APPROVED/REJECTED weggefallen.
 */
const notify = async (
    tenantId: string,
    recipientIds: string[],
    task: { id: string; title: string },
    actor: string,
) => {
    const recipients = [...new Set(recipientIds.filter(Boolean))];
    if (recipients.length === 0) return;
    await prisma.notification.createMany({
        data: recipients.map((recipientEmployeeId) => ({
            id: nanoid(12),
            tenantId,
            recipientEmployeeId,
            type: 'TASK_ASSIGNED',
            title: `Neue Aufgabe: ${task.title}`,
            message: actor ? `${actor} · ${task.title}` : task.title,
            linkUrl: `/crm/tasks/${task.id}`,
            metadata: {
                taskId: task.id,
                i18n: { key: 'notify.taskAssigned', params: { actor, title: task.title } },
            },
        })),
    });
};

/** Bilder einer Notiz: nur Daten-URLs von Bildern, gedeckelt in Zahl und Grösse. */
const sanitizeImages = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((value) => String(value || ''))
        .filter((value) => value.startsWith('data:image/') && value.length <= MAX_IMAGE_CHARS)
        .slice(0, MAX_NOTE_IMAGES);
};

/** Verantwortliche aller Zeilen einer Seite in EINEM Statement. */
const assigneesFor = async (taskIds: string[]) => {
    if (taskIds.length === 0) return new Map<string, Array<{ id: string; firstName: string; lastName: string }>>();
    const rows = await prisma.crmTaskAssignee.findMany({
        where: { taskId: { in: taskIds } },
        select: { taskId: true, employee: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: 'asc' },
    });
    const map = new Map<string, Array<{ id: string; firstName: string; lastName: string }>>();
    rows.forEach((row) => {
        const list = map.get(row.taskId) ?? [];
        list.push({ id: row.employee.id, firstName: row.employee.firstName, lastName: row.employee.lastName });
        map.set(row.taskId, list);
    });
    return map;
};

const noteRow = (note: any) => ({
    id: note.id,
    text: note.text,
    images: Array.isArray(note.images) ? note.images : [],
    createdAt: note.createdAt,
    author: note.author ? { id: note.author.id, firstName: note.author.firstName, lastName: note.author.lastName } : null,
});

// ─────────────────────────── Reminders ───────────────────────────

/**
 * GET /crm/reminders/due — fällige Erinnerungen für die angemeldete Person.
 * "Für mich" = ich stehe in den Verantwortlichen (und MEIN Stempel fehlt noch)
 * ODER niemand ist verantwortlich und ich habe sie erfasst. Auth-only.
 */
router.get('/reminders/due', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
            SELECT tk.id, tk.title, tk.dueDate, tk.customerId, tk.linkUrl, tk.meta,
                   cu.companyName AS customerName
            FROM CrmTask tk
            LEFT JOIN Customer cu ON cu.id = tk.customerId
            WHERE tk.tenantId = ${user.tenantId}
              AND tk.kind = 'REMINDER'
              AND tk.status = 'OPEN'
              AND tk.dueDate IS NOT NULL
              AND tk.dueDate <= NOW(3)
              AND (
                    EXISTS (SELECT 1 FROM CrmTaskAssignee ta
                             WHERE ta.taskId = tk.id AND ta.employeeId = ${user.id} AND ta.notifiedAt IS NULL)
                 OR (tk.notifiedAt IS NULL
                     AND tk.createdByEmployeeId = ${user.id}
                     AND NOT EXISTS (SELECT 1 FROM CrmTaskAssignee ta2 WHERE ta2.taskId = tk.id))
              )
            ORDER BY tk.dueDate ASC
            LIMIT 20
        `);
        res.status(200).json(rows.map((row) => ({
            id: row.id,
            title: row.title,
            dueDate: row.dueDate,
            customerId: row.customerId ?? null,
            customerName: row.customerName ?? null,
            linkUrl: row.linkUrl ?? null,
            meta: parseJson(row.meta),
        })));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** POST /crm/reminders/ack — { ids } — stempelt MEINE Sicht der gezeigten Erinnerungen. */
router.post('/reminders/ack', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id: unknown) => String(id || '').trim()).filter(Boolean) : [];
        if (ids.length === 0) return res.status(200).json({ acknowledged: 0 });
        const [mine, own] = await Promise.all([
            prisma.crmTaskAssignee.updateMany({
                where: { taskId: { in: ids }, employeeId: user.id, notifiedAt: null },
                data: { notifiedAt: new Date() },
            }),
            prisma.crmTask.updateMany({
                where: { id: { in: ids }, tenantId: user.tenantId, kind: 'REMINDER', notifiedAt: null, createdByEmployeeId: user.id, assignees: { none: {} } },
                data: { notifiedAt: new Date() },
            }),
        ]);
        res.status(200).json({ acknowledged: mine.count + own.count });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /crm/reminders/dismiss — { ids }. Schliesst Erinnerungen ENDGÜLTIG für
 * mich: bin ich eine von mehreren Verantwortlichen, fällt nur MEINE Zeile weg;
 * bin ich die letzte (oder die Erfassende ohne Verantwortliche), wird die
 * Erinnerung gelöscht.
 */
router.post('/reminders/dismiss', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id: unknown) => String(id || '').trim()).filter(Boolean) : [];
        if (ids.length === 0) return res.status(200).json({ dismissed: 0 });
        const tasks = await prisma.crmTask.findMany({
            where: { id: { in: ids }, tenantId: user.tenantId, kind: 'REMINDER' },
            select: { id: true, createdByEmployeeId: true, assignees: { select: { employeeId: true } } },
        });
        let dismissed = 0;
        for (const task of tasks) {
            const others = task.assignees.filter((row) => row.employeeId !== user.id);
            const mine = task.assignees.some((row) => row.employeeId === user.id);
            if (mine && others.length > 0) {
                await prisma.crmTaskAssignee.deleteMany({ where: { taskId: task.id, employeeId: user.id } });
                await prisma.crmTask.update({ where: { id: task.id }, data: { assigneeEmployeeId: others[0]?.employeeId ?? null } });
                dismissed += 1;
            } else if (mine || task.createdByEmployeeId === user.id) {
                await prisma.crmTask.delete({ where: { id: task.id } });
                dismissed += 1;
            }
        }
        res.status(200).json({ dismissed });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ─────────────────────── Tasks & reminders ───────────────────────

/**
 * GET /crm/tasks?status=&customerId=&assigneeId=&kind=&scope=&from=&to=&page=&pageSize=
 *
 * `scope` = me | by | mine (Altwert) → nur Beteiligung, dann auth-only; ohne
 * `scope` die ganze Firma (crm.customers.view). `from`/`to` sind ISO-Zeitpunkte
 * und grenzen den Termin auf eine Woche ein — Aufgaben ohne Termin kommen mit.
 */
router.get('/tasks', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const scope = String(req.query.scope || '').trim();
        const scoped = scope === 'me' || scope === 'by' || scope === 'mine';
        if (!scoped && !(await hasPermission(user.id, 'crm.customers.view'))) {
            return res.status(403).json({ error: "Erişim Engellendi: 'crm.customers.view' yetkisi gerekli." });
        }
        const status = String(req.query.status || '').trim().toUpperCase();
        const kind = String(req.query.kind || '').trim().toUpperCase();
        /* MEHRERE Kunden und MEHRERE Personen (11.09.2026, Vorgabe Samet:
           "man muss mehrere Mitarbeitende oder alle waehlen koennen ... alle
           Kunden, bestimmte Kunden oder einen einzigen"). Leer heisst alle;
           die alten Einzahl-Parameter zaehlen als Liste mit einem Eintrag. */
        const customerIds = [...new Set([
            ...parseIdList(req.query.customerIds),
            ...parseIdList(req.query.customerId),
        ])];
        const assigneeIds = [...new Set([
            ...parseIdList(req.query.assigneeIds),
            ...parseIdList(req.query.assigneeId),
        ])];
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const { page, pageSize, skip, take } = parsePage(req);

        const conditions: Prisma.Sql[] = [Prisma.sql`tk.tenantId = ${user.tenantId}`];
        if (TASK_STATUSES.has(status)) conditions.push(Prisma.sql`tk.status = ${status}`);
        if (kind === 'TASK' || kind === 'REMINDER') conditions.push(Prisma.sql`tk.kind = ${kind}`);
        if (customerIds.length) conditions.push(Prisma.sql`tk.customerId IN (${Prisma.join(customerIds)})`);
        if (assigneeIds.length) {
            conditions.push(Prisma.sql`(tk.assigneeEmployeeId IN (${Prisma.join(assigneeIds)})
                OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = tk.id AND ta.employeeId IN (${Prisma.join(assigneeIds)})))`);
        }
        /* UEBERSCHNEIDUNG statt Endtermin (11.09.2026). Eine Aufgabe hat jetzt
           einen Anfang und ein Ende und darf sich ueber mehrere Tage ziehen -
           sie gehoert in den Zeitraum, sobald sie ihn BERUEHRT. Fragte man
           weiterhin nur nach `dueDate`, verschwaende eine Aufgabe von Montag
           bis Freitag aus jeder Wochenansicht, die den Freitag nicht enthaelt.
           `COALESCE` deckt die eintaegige Aufgabe ab (nur `dueDate` gesetzt)
           und die offene (nur `startAt`); Aufgaben ganz OHNE Termin kommen
           weiterhin in jedem Fenster mit - sie haengen an keinem Tag. */
        const spanStart = Prisma.sql`COALESCE(tk.startAt, tk.dueDate)`;
        const spanEnd = Prisma.sql`COALESCE(tk.dueDate, tk.startAt)`;
        const undated = Prisma.sql`(tk.startAt IS NULL AND tk.dueDate IS NULL)`;
        if (from && to) conditions.push(Prisma.sql`(${undated} OR (${spanStart} < ${to} AND ${spanEnd} >= ${from}))`);
        else if (from) conditions.push(Prisma.sql`(${undated} OR ${spanEnd} >= ${from})`);
        else if (to) conditions.push(Prisma.sql`(${undated} OR ${spanStart} < ${to})`);
        /* MIT MIR = ich stehe in den Verantwortlichen (auch selbst zugewiesen);
           OHNE MICH = ich habe sie zugewiesen, bin aber selbst NICHT
           verantwortlich (Vorgabe 19.08.2026 — die beiden Sichten sollen sich
           nicht überschneiden). Eine Aufgabe ohne Verantwortliche gehört zu
           "mit mir", wenn ich sie erfasst habe: sonst fiele sie aus beiden. */
        const involvedSql = Prisma.sql`(tk.assigneeEmployeeId = ${user.id}
            OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = tk.id AND ta.employeeId = ${user.id})
            OR (tk.createdByEmployeeId = ${user.id}
                AND tk.assigneeEmployeeId IS NULL
                AND NOT EXISTS (SELECT 1 FROM CrmTaskAssignee ta2 WHERE ta2.taskId = tk.id)))`;
        if (scope === 'me') conditions.push(involvedSql);
        else if (scope === 'by') conditions.push(Prisma.sql`(tk.createdByEmployeeId = ${user.id} AND NOT ${involvedSql})`);
        else if (scope === 'mine') conditions.push(Prisma.sql`(tk.createdByEmployeeId = ${user.id} OR ${involvedSql})`);
        const whereSql = Prisma.join(conditions, ' AND ');

        if (kind !== 'REMINDER' && status !== 'DONE') await flipOverdueTasks(user.tenantId);

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT tk.id, tk.kind, tk.title, tk.labelId, tk.customerId, tk.contactId, tk.assigneeEmployeeId,
                       tk.startAt, tk.allDay, tk.dueDate, tk.status, tk.completedAt, tk.tenderId,
                       tk.createdByEmployeeId, tk.createdAt,
                       tk.linkUrl, tk.meta, tk.entityType, tk.entityId,
                       cu.companyName AS customerName,
                       ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                       a.firstName AS assigneeFirstName, a.lastName AS assigneeLastName,
                       e.firstName AS byFirstName, e.lastName AS byLastName,
                       td.tenderNumber AS tenderNumber,
                       (SELECT COUNT(*) FROM CrmTaskNote n WHERE n.taskId = tk.id) AS noteCount,
                       (SELECT COUNT(*) FROM CrmTaskDocument d WHERE d.taskId = tk.id) AS documentCount,
                       (SELECT COUNT(*) FROM CrmTaskStep st WHERE st.taskId = tk.id) AS stepCount,
                       (SELECT COUNT(*) FROM CrmTaskStep st WHERE st.taskId = tk.id AND st.done = 1) AS stepDoneCount
                FROM CrmTask tk
                LEFT JOIN Customer cu ON cu.id = tk.customerId
                LEFT JOIN CustomerContact ct ON ct.id = tk.contactId
                LEFT JOIN Employee a ON a.id = tk.assigneeEmployeeId
                LEFT JOIN Tender td ON td.id = tk.tenderId
                JOIN Employee e ON e.id = tk.createdByEmployeeId
                WHERE ${whereSql}
                ORDER BY (COALESCE(tk.startAt, tk.dueDate) IS NULL) ASC, COALESCE(tk.startAt, tk.dueDate) ASC,
                         FIELD(tk.status, 'OPEN', 'INCOMPLETE', 'DONE') ASC,
                         tk.createdAt ASC, tk.id ASC
                LIMIT ${take} OFFSET ${skip}
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                SELECT COUNT(*) AS total FROM CrmTask tk WHERE ${whereSql}
            `),
        ]);
        const assigneeMap = await assigneesFor(rows.map((row) => String(row.id)));

        const data = rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            title: row.title,
            labelId: row.labelId ?? null,
            customerId: row.customerId ?? null,
            contactId: row.contactId ?? null,
            assigneeEmployeeId: row.assigneeEmployeeId ?? null,
            startAt: row.startAt ?? null,
            allDay: Boolean(row.allDay ?? true),
            dueDate: row.dueDate ?? null,
            status: row.status,
            completedAt: row.completedAt ?? null,
            createdAt: row.createdAt,
            createdByEmployeeId: row.createdByEmployeeId,
            noteCount: Number(row.noteCount ?? 0),
            documentCount: Number(row.documentCount ?? 0),
            stepCount: Number(row.stepCount ?? 0),
            stepDoneCount: Number(row.stepDoneCount ?? 0),
            tenderId: row.tenderId ?? null,
            tender: row.tenderId ? { id: row.tenderId, tenderNumber: row.tenderNumber ?? '' } : null,
            linkUrl: row.linkUrl ?? null,
            meta: parseJson(row.meta),
            entityType: row.entityType ?? null,
            entityId: row.entityId ?? null,
            customer: row.customerId ? { id: row.customerId, companyName: row.customerName } : null,
            contact: personOrNull(row.contactId, row.contactFirstName, row.contactLastName),
            assignee: personOrNull(row.assigneeEmployeeId, row.assigneeFirstName, row.assigneeLastName),
            assignees: assigneeMap.get(String(row.id)) ?? [],
            createdBy: personOrNull(row.createdByEmployeeId, row.byFirstName, row.byLastName),
        }));
        res.status(200).json({ data, total: Number(countRows[0]?.total ?? 0), page, pageSize });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** GET /crm/tasks/:id — die Aufgabenseite: Kopf, Verantwortliche, Notizen. Beteiligte oder crm.customers.view. */
router.get('/tasks/:id', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const task = await prisma.crmTask.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            include: {
                customer: { select: { id: true, companyName: true } },
                contact: { select: { id: true, firstName: true, lastName: true } },
                createdBy: { select: { id: true, firstName: true, lastName: true } },
                assignees: { select: { employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' } },
                notes: { include: { author: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' } },
                /* Anleitung und Anhänge kommen MIT (11.09.2026): die
                   Erledigungskarte zeigt beide, sobald sie offen ist — dafür
                   noch einen zweiten und dritten Aufruf zu machen, wäre bei
                   einer Karte, die man im Tagesbetrieb ständig auf- und
                   zuklappt, drei Netzwege statt einem. Der INHALT der Anhänge
                   bleibt draussen; er kommt erst beim Öffnen. */
                steps: { orderBy: { position: 'asc' } },
                documents: { select: documentListSelect, orderBy: { createdAt: 'asc' } },
                tender: { select: { id: true, tenderNumber: true } },
            },
        });
        if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        const participant = task.createdByEmployeeId === user.id
            || task.assigneeEmployeeId === user.id
            || task.assignees.some((row) => row.employee.id === user.id);
        if (!participant && !(await hasPermission(user.id, 'crm.customers.view'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }
        res.status(200).json({
            id: task.id,
            kind: task.kind,
            title: task.title,
            status: task.status,
            startAt: task.startAt,
            allDay: task.allDay,
            dueDate: task.dueDate,
            completedAt: task.completedAt,
            createdAt: task.createdAt,
            createdByEmployeeId: task.createdByEmployeeId,
            customer: task.customer,
            contact: task.contact,
            tenderId: task.tenderId,
            tender: task.tender,
            createdBy: task.createdBy,
            assignees: task.assignees.map((row) => row.employee),
            notes: task.notes.map(noteRow),
            steps: task.steps.map(stepRow),
            documents: task.documents,
        });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** POST /crm/tasks — { title, customerId?, contactId?, assigneeEmployeeIds?|assigneeEmployeeId?, dueDate?, kind? } */
router.post('/tasks', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const title = String(req.body?.title || '').trim();
        if (!title) return res.status(400).json({ error: 'Titel gerekli.' });
        const customerId = String(req.body?.customerId || '').trim();
        const contactId = String(req.body?.contactId || '').trim();
        const tenderId = String(req.body?.tenderId || '').trim();
        const kind = req.body?.kind === 'REMINDER' ? 'REMINDER' : 'TASK';
        /* ANFANG UND ENDE (11.09.2026). `dueDate` ist das ENDE; `startAt` darf
           fehlen, dann ist die Aufgabe eintägig und beginnt mit ihrem Ende.
           Kommt der Anfang NACH dem Ende, werden die beiden getauscht statt
           eine leere Spanne zu speichern — dieselbe Nachsicht wie beim
           Zeitraumfilter der Liste. */
        const allDay = req.body?.allDay === undefined ? true : Boolean(req.body.allDay);
        const { startAt, dueDate } = orderSpan(parseDate(req.body?.startAt), parseDate(req.body?.dueDate));
        const steps = parseSteps(req.body?.steps) ?? [];
        const wantedAssignees = parseAssigneeIds(req.body) ?? [];

        const [customer, contact, tender, assigneeIds] = await Promise.all([
            customerId ? prisma.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true } }) : Promise.resolve(null),
            contactId && customerId ? prisma.customerContact.findFirst({ where: { id: contactId, customerId }, select: { id: true } }) : Promise.resolve(null),
            tenderId ? prisma.tender.findFirst({ where: { id: tenderId, tenantId: user.tenantId }, select: { id: true } }) : Promise.resolve(null),
            validateEmployees(wantedAssignees, user.tenantId),
        ]);
        if (customerId && !customer) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
        if (contactId && !contact) return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
        if (tenderId && !tender) return res.status(404).json({ error: 'Offerte nicht gefunden.' });
        if (assigneeIds.length !== wantedAssignees.length) return res.status(400).json({ error: 'Verantwortliche Person nicht gefunden.' });
        /* KALENDER-ETIKETT (25.08.2026). Eine Aufgabe steht NICHT mehr im
           Raster des Kalenders (Vorgabe: «Aufgaben raus, sie machen den
           Kalender voll»), sie bekommt darum auch keinen Vorschlag. Die
           Spalte bleibt, damit ein ausdrücklich gesetztes Etikett -- etwa aus
           dem Aufgabenbrett -- nicht verloren geht. */
        const labelId = (await sanitizeLabelId(user.tenantId, req.body?.labelId)) ?? null;

        const created = await prisma.crmTask.create({
            data: {
                id: nanoid(12),
                tenantId: user.tenantId,
                kind,
                labelId,
                title,
                customerId: customer ? customerId : null,
                contactId: contact ? contactId : null,
                tenderId: tender ? tenderId : null,
                assigneeEmployeeId: assigneeIds[0] ?? null,
                startAt,
                allDay,
                dueDate,
                createdByEmployeeId: user.id,
                assignees: { create: assigneeIds.map((employeeId) => ({ id: nanoid(12), employeeId })) },
                // Die Anleitung reist MIT der Anlage; die Anhänge kommen als
                // eigene Sendung nach (sie sind Dateien, kein JSON).
                steps: { create: steps.map((step, index) => ({ id: nanoid(12), position: index, text: step.text, done: step.done })) },
            },
        });
        // Fremd zugewiesene Aufgaben melden sich bei den Verantwortlichen.
        if (kind === 'TASK') {
            await notify(user.tenantId, assigneeIds.filter((id) => id !== user.id), created, await actorName(user.id));
            /* … und zusätzlich per Mail (19.08.2026): die Meldung im ERP sieht
               nur, wer gerade angemeldet ist. Die Mail geht NUR an die
               Verantwortlichen, nie an die Person, die die Aufgabe verteilt hat. */
            queueTaskAssignmentMail(created.id, user.id);
        }
        res.status(201).json(created);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /crm/tasks/bulk — { entries: [{ title, customerId?, contactId?, tenderId?, assigneeEmployeeIds?|assigneeEmployeeId?, startAt?, dueDate?, allDay?, kind? }] }
 * Feste Anzahl Prüfabfragen, dann eine Anlage je Zeile in EINER Transaktion.
 */
router.post('/tasks/bulk', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
        if (rawEntries.length === 0) return res.status(400).json({ error: 'Keine Zeilen übergeben.' });
        if (rawEntries.length > 200) return res.status(400).json({ error: 'Höchstens 200 Zeilen pro Speicherung.' });

        const entries = rawEntries.map((row: any, index: number) => ({
            index,
            title: String(row?.title || '').trim(),
            customerId: String(row?.customerId || '').trim(),
            contactId: String(row?.contactId || '').trim(),
            tenderId: String(row?.tenderId || '').trim(),
            assigneeIds: parseAssigneeIds(row) ?? [],
            kind: row?.kind === 'REMINDER' ? 'REMINDER' : 'TASK',
            /* Auch die Tabellen-Erfassung kennt seit dem 11.09.2026 Anfang und
               Ende; schickt sie nur einen Termin, ist die Aufgabe eintaegig. */
            ...orderSpan(parseDate(row?.startAt), parseDate(row?.dueDate)),
            allDay: row?.allDay === undefined ? true : Boolean(row.allDay),
        }));
        const errors: Array<{ index: number; error: string }> = [];

        const customerIds = [...new Set(entries.map((entry: any) => entry.customerId).filter(Boolean))] as string[];
        const contactIds = [...new Set(entries.map((entry: any) => entry.contactId).filter(Boolean))] as string[];
        const assigneeIds = [...new Set(entries.flatMap((entry: any) => entry.assigneeIds))] as string[];
        const tenderIds = [...new Set(entries.map((entry: any) => entry.tenderId).filter(Boolean))] as string[];
        const [customers, contacts, assignees, tenders] = await Promise.all([
            customerIds.length ? prisma.customer.findMany({ where: { id: { in: customerIds }, tenantId: user.tenantId }, select: { id: true } }) : Promise.resolve([]),
            contactIds.length ? prisma.customerContact.findMany({ where: { id: { in: contactIds }, tenantId: user.tenantId }, select: { id: true, customerId: true } }) : Promise.resolve([]),
            assigneeIds.length ? prisma.employee.findMany({ where: { id: { in: assigneeIds }, ...employeeScopeWhere(await getPersonnelTenantScope(user.tenantId)) }, select: { id: true } }) : Promise.resolve([]),
            tenderIds.length ? prisma.tender.findMany({ where: { id: { in: tenderIds }, tenantId: user.tenantId }, select: { id: true } }) : Promise.resolve([]),
        ]);
        const allowedCustomers = new Set(customers.map((row) => row.id));
        const contactOwner = new Map(contacts.map((row) => [row.id, row.customerId]));
        const allowedAssignees = new Set(assignees.map((row) => row.id));
        const allowedTenders = new Set(tenders.map((row) => row.id));

        const valid = entries.filter((entry: any) => {
            if (!entry.title) { errors.push({ index: entry.index, error: 'Titel fehlt.' }); return false; }
            if (entry.customerId && !allowedCustomers.has(entry.customerId)) { errors.push({ index: entry.index, error: 'Kunde nicht gefunden.' }); return false; }
            if (entry.contactId && (!entry.customerId || contactOwner.get(entry.contactId) !== entry.customerId)) { errors.push({ index: entry.index, error: 'Ansprechpartner gehört nicht zu diesem Kunden.' }); return false; }
            if (entry.assigneeIds.some((id: string) => !allowedAssignees.has(id))) { errors.push({ index: entry.index, error: 'Verantwortliche Person nicht gefunden.' }); return false; }
            if (entry.tenderId && !allowedTenders.has(entry.tenderId)) { errors.push({ index: entry.index, error: 'Offerte nicht gefunden.' }); return false; }
            return true;
        });

        const createdIds: Array<{ id: string; title: string; kind: string; assigneeIds: string[] }> = [];
        if (valid.length) {
            await prisma.$transaction(valid.map((entry: any) => {
                const id = nanoid(12);
                createdIds.push({ id, title: entry.title, kind: entry.kind, assigneeIds: entry.assigneeIds });
                return prisma.crmTask.create({
                    data: {
                        id,
                        tenantId: user.tenantId,
                        kind: entry.kind,
                        title: entry.title,
                        customerId: entry.customerId || null,
                        contactId: entry.contactId || null,
                        tenderId: entry.tenderId || null,
                        assigneeEmployeeId: entry.assigneeIds[0] ?? null,
                        startAt: entry.startAt,
                        allDay: entry.allDay,
                        dueDate: entry.dueDate,
                        createdByEmployeeId: user.id,
                        assignees: { create: entry.assigneeIds.map((employeeId: string) => ({ id: nanoid(12), employeeId })) },
                    },
                });
            }));
            const actor = await actorName(user.id);
            for (const row of createdIds) {
                if (row.kind === 'TASK') {
                    await notify(user.tenantId, row.assigneeIds.filter((id) => id !== user.id), row, actor);
                    queueTaskAssignmentMail(row.id, user.id);
                }
            }
        }
        res.status(201).json({ createdCount: createdIds.length, errors });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * PATCH /crm/tasks/:id — Teilaktualisierung. Beteiligte dürfen Status und
 * Termin setzen (Karte abhaken bzw. auf einen anderen Wochentag ziehen) — alles
 * andere braucht crm.activities.create. DONE ist DONE: wer abhakt, erledigt.
 */
router.patch('/tasks/:id', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        const bodyKeys = Object.keys(req.body || {});
        /* WAS BETEILIGTE OHNE VERWALTUNGSRECHT SETZEN DÜRFEN (und was darum
           den Schnellweg nimmt): abhaken und umterminieren. Seit dem
           11.09.2026 gehören `startAt` und `allDay` dazu — eine Aufgabe hat
           einen Anfang und ein Ende, und wer sie abarbeitet, muss sie
           verschieben können, ohne CRM-Verwalterin zu sein. Ohne diese zwei
           Namen fiele jedes Verschieben in den ausführlichen Weg und würde den
           Verantwortlichen mit 403 abgewiesen. */
        const onlyStatus = bodyKeys.length > 0 && bodyKeys.every((key) => key === 'status'
            || key === 'dueDate' || key === 'startAt' || key === 'allDay');

        /* SCHNELLWEG für das Abhaken und das Umterminieren: EINE Anweisung, die
           Rechteprüfung steckt in ihrem WHERE. Der ausführliche Weg unten kostet
           vier Runden zur entfernten Datenbank (Laden + Verantwortliche +
           Rechte + Schreiben) — bei ~60 ms je Runde waren das 600–900 ms für das
           Setzen EINER Spalte. Trifft die Anweisung keine Zeile (fremde Aufgabe,
           Verwaltungsrecht statt Beteiligung), geht es unten normal weiter. */
        if (onlyStatus) {
            const fast = await fastPatchStatus(id, user.tenantId, user.id, req.body);
            if (fast === 'BAD_STATUS') return res.status(400).json({ error: 'Status OPEN, DONE oder INCOMPLETE olmalıdır.' });
            if (fast) return res.status(200).json(fast);
        }

        const existing = await loadTaskCore(id, user.tenantId);
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        const participant = isParticipant(existing, user.id);
        const canManage = await hasPermission(user.id, 'crm.activities.create');
        if (!canManage && !(participant && onlyStatus)) {
            return res.status(403).json({ error: 'Keine Berechtigung, diese Aufgabe zu ändern.' });
        }

        const data: Record<string, unknown> = {};
        if (req.body?.title !== undefined) {
            const title = String(req.body.title).trim();
            if (!title) return res.status(400).json({ error: 'Titel gerekli.' });
            data.title = title;
        }
        if (req.body?.kind !== undefined) data.kind = req.body.kind === 'REMINDER' ? 'REMINDER' : 'TASK';
        /* ANFANG UND ENDE (11.09.2026). Wird nur EINES der beiden geschickt,
           steht das andere weiterhin in der Zeile — darum wird gegen den
           bestehenden Wert getauscht und nicht nur gegen das Mitgeschickte.
           Ohne das könnte ein "Anfang auf Freitag" bei einem Ende am Dienstag
           eine verkehrte Spanne hinterlassen. */
        if (req.body?.startAt !== undefined || req.body?.dueDate !== undefined) {
            const current = await prisma.crmTask.findFirst({
                where: { id, tenantId: user.tenantId },
                select: { startAt: true, dueDate: true },
            });
            const span = orderSpan(
                req.body?.startAt !== undefined ? parseDate(req.body.startAt) : current?.startAt ?? null,
                req.body?.dueDate !== undefined ? parseDate(req.body.dueDate) : current?.dueDate ?? null,
            );
            data.startAt = span.startAt;
            data.dueDate = span.dueDate;
        }
        if (req.body?.allDay !== undefined) data.allDay = Boolean(req.body.allDay);
        if (req.body?.tenderId !== undefined) {
            const tenderId = String(req.body.tenderId || '').trim();
            if (tenderId) {
                const tender = await prisma.tender.findFirst({ where: { id: tenderId, tenantId: user.tenantId }, select: { id: true } });
                if (!tender) return res.status(404).json({ error: 'Offerte nicht gefunden.' });
            }
            data.tenderId = tenderId || null;
        }
        if (req.body?.labelId !== undefined) data.labelId = await sanitizeLabelId(user.tenantId, req.body.labelId) ?? null;
        if (req.body?.customerId !== undefined) {
            const customerId = String(req.body.customerId || '').trim();
            if (customerId) {
                const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true } });
                if (!customer) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            data.customerId = customerId || null;
            if (customerId !== existing.customerId) data.contactId = null;
        }
        if (req.body?.contactId !== undefined) {
            const contactId = String(req.body.contactId || '').trim();
            const ownerId = (data.customerId as string | null | undefined) ?? existing.customerId;
            if (contactId) {
                const contact = ownerId ? await prisma.customerContact.findFirst({ where: { id: contactId, customerId: ownerId }, select: { id: true } }) : null;
                if (!contact) return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
            }
            data.contactId = contactId || null;
        }

        const wantedAssignees = parseAssigneeIds(req.body);
        let assigneeIds: string[] | null = null;
        if (wantedAssignees !== undefined) {
            assigneeIds = await validateEmployees(wantedAssignees, user.tenantId);
            if (assigneeIds.length !== wantedAssignees.length) return res.status(400).json({ error: 'Verantwortliche Person nicht gefunden.' });
        }

        if (req.body?.status !== undefined) {
            const status = String(req.body.status).trim().toUpperCase();
            if (!TASK_STATUSES.has(status)) {
                return res.status(400).json({ error: 'Status OPEN, DONE oder INCOMPLETE olmalıdır.' });
            }
            data.status = status;
            data.completedAt = status === 'DONE' ? new Date() : null;
        }

        const updated = await prisma.crmTask.update({ where: { id: existing.id }, data });
        // Die Anleitung darf im selben Zug mitkommen (das Fenster speichert
        // alles auf einmal); sie hat daneben ihren eigenen Endpunkt für die
        // Beteiligten, die kein Verwaltungsrecht haben.
        const steps = parseSteps(req.body?.steps);
        if (steps !== undefined) await replaceSteps(existing.id, steps);
        if (assigneeIds !== null) {
            await replaceAssignees(existing.id, assigneeIds);
            const before = new Set(existing.assignees.map((row) => row.employeeId));
            const fresh = assigneeIds.filter((id) => !before.has(id) && id !== user.id);
            if (fresh.length && existing.kind === 'TASK') {
                await notify(user.tenantId, fresh, existing, await actorName(user.id));
                /* Nur die NEU hinzugekommenen Personen bekommen Post — wer schon
                   vorher verantwortlich war, hat ihre Mail längst. */
                queueTaskAssignmentMail(existing.id, user.id, {
                    skipEmployeeIds: existing.assignees.map((row) => row.employeeId),
                });
            }
        }
        res.status(200).json({ ...updated, assigneeIds: assigneeIds ?? existing.assignees.map((row) => row.employeeId) });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ──────────────── Anleitung (Schritt für Schritt) ────────────────

/**
 * PUT /crm/tasks/:id/steps — { steps: [{ text, done }] }
 *
 * Die ganze Anleitung auf einmal (11.09.2026). Ersetzen statt Einzelpflege:
 * die Liste ist kurz, wird im Fenster als Block bearbeitet (Zeile dazu,
 * Zeile weg, umsortiert), und ein Zug spart drei bis fünf Netzwege.
 *
 * BETEILIGTE dürfen sie schreiben — wer eine Aufgabe abarbeitet, hakt ihre
 * Schritte ab; dafür ein Verwaltungsrecht zu verlangen, hiesse, dass die
 * Anleitung für genau die Person gesperrt ist, für die sie geschrieben wurde.
 */
router.put('/tasks/:id/steps', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const existing = await loadTaskCore(String(req.params.id || ''), user.tenantId);
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        if (!isParticipant(existing, user.id) && !(await hasPermission(user.id, 'crm.activities.create'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }
        const steps = parseSteps(req.body?.steps) ?? [];
        await replaceSteps(existing.id, steps);
        const saved = await prisma.crmTaskStep.findMany({ where: { taskId: existing.id }, orderBy: { position: 'asc' } });
        res.status(200).json(saved.map(stepRow));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * PATCH /crm/tasks/:id/steps/:stepId — { done }
 *
 * Der Griff des Alltags: EIN Häkchen. Er bekommt seinen eigenen Endpunkt,
 * weil das Ersetzen der ganzen Liste für ein einziges Häkchen die Anleitung
 * einer anderen, gleichzeitig offenen Karte überschreiben könnte.
 */
router.patch('/tasks/:id/steps/:stepId', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const existing = await loadTaskCore(String(req.params.id || ''), user.tenantId);
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        if (!isParticipant(existing, user.id) && !(await hasPermission(user.id, 'crm.activities.create'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }
        const data: Record<string, unknown> = {};
        if (req.body?.done !== undefined) data.done = Boolean(req.body.done);
        if (req.body?.text !== undefined) {
            const text = String(req.body.text).trim().slice(0, MAX_STEP_CHARS);
            if (!text) return res.status(400).json({ error: 'Ein Schritt braucht einen Text.' });
            data.text = text;
        }
        // `updateMany` und nicht `update`: die Zeile könnte zwischen Fund und
        // Schreiben von einem zweiten offenen Fenster gestrichen worden sein.
        const changed = await prisma.crmTaskStep.updateMany({
            where: { id: String(req.params.stepId || ''), taskId: existing.id },
            data,
        });
        if (!changed.count) return res.status(404).json({ error: 'Schritt nicht gefunden.' });
        const step = await prisma.crmTaskStep.findUnique({ where: { id: String(req.params.stepId || '') } });
        res.status(200).json(step ? stepRow(step) : null);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ──────────────────── Anhänge (Bild UND PDF) ─────────────────────

/* Die Dateien reisen ROH (multipart) — derselbe Weg wie Angebots- und
   Terminunterlagen, und der Grund, warum das Anhängen sofort geht. Base64 in
   einem JSON-Körper wäre ein Drittel grösser und müsste zweimal umkodiert
   werden; `sanitizeDocumentUpload` nimmt ihn trotzdem noch an (Skripte). */
const taskDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 20 },
});

/** Und je Aufgabe höchstens 40 MB, damit die Karte ladbar bleibt. */
const TASK_DOCUMENT_LIMIT_BYTES = 40 * 1024 * 1024;

/**
 * POST /crm/tasks/:id/documents — multipart `files[]` (oder EIN `file`).
 *
 * Bilder UND PDF (Vorgabe 11.09.2026: «beim Anlegen dieser kleinen
 * Zeichen-Knöpfe und ebenso beim Ändern sollen wir nicht nur PNG, sondern
 * auch PDF anhängen können»). Alle in EINER Sendung: Anmeldung, Rechteprüfung
 * und Aufgabenabfrage laufen damit auch bei zehn Dateien nur einmal.
 *
 * Beteiligte dürfen anhängen — wie bei den Notizen.
 */
router.post('/tasks/:id/documents', requireAuth, taskDocumentUpload.any(), async (req, res) => {
    /* Was schon auf der Platte liegt, wenn die Zeile scheitert, muss wieder
       weg — sonst bleiben Waisen liegen. */
    const storedRefs: string[] = [];
    try {
        const user = req.user!;
        const existing = await loadTaskCore(String(req.params.id || ''), user.tenantId);
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        if (!isParticipant(existing, user.id) && !(await hasPermission(user.id, 'crm.activities.create'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }

        const files = Array.isArray((req as any).files) ? (req as any).files : [];
        const uploads = files.length
            ? files.map((file: any) => sanitizeDocumentUpload(req.body, file))
            : [sanitizeDocumentUpload(req.body)];

        const current = await prisma.crmTaskDocument.aggregate({
            where: { taskId: existing.id },
            _sum: { sizeBytes: true },
        });
        const incoming = uploads.reduce((sum: number, upload: any) => sum + upload.sizeBytes, 0);
        if (Number(current?._sum?.sizeBytes || 0) + incoming > TASK_DOCUMENT_LIMIT_BYTES) {
            return res.status(400).json({
                error: `Die Anhänge einer Aufgabe dürfen zusammen höchstens ${Math.round(TASK_DOCUMENT_LIMIT_BYTES / (1024 * 1024))} MB gross sein.`,
            });
        }

        for (const upload of uploads) {
            storedRefs.push(await taskDocumentStorage.store(user.tenantId, upload.body, upload.contentType));
        }
        await prisma.crmTaskDocument.createMany({
            data: uploads.map((upload: any, index: number) => ({
                id: nanoid(12),
                tenantId: user.tenantId,
                taskId: existing.id,
                fileName: upload.fileName,
                contentType: upload.contentType,
                sizeBytes: upload.sizeBytes,
                fileRef: storedRefs[index],
                uploadedById: user.id,
            })),
        });
        storedRefs.length = 0;
        const documents = await prisma.crmTaskDocument.findMany({
            where: { taskId: existing.id },
            select: documentListSelect,
            orderBy: { createdAt: 'asc' },
        });
        res.status(201).json(documents);
    } catch (error: any) {
        await Promise.all(storedRefs.map((reference) => taskDocumentStorage.remove(reference).catch(() => undefined)));
        res.status(error?.status || 400).json({ error: error.message });
    }
});

/**
 * GET /crm/tasks/documents/:documentId — der INHALT eines Anhangs als
 * Daten-URI. Erst hier reist er über die Leitung; die Liste an der Karte
 * bleibt federleicht.
 */
router.get('/tasks/documents/:documentId', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const document = await prisma.crmTaskDocument.findFirst({
            where: { id: String(req.params.documentId || ''), tenantId: user.tenantId },
        });
        if (!document) return res.status(404).json({ error: 'Anhang nicht gefunden.' });
        const task = await loadTaskCore(document.taskId, user.tenantId);
        if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        if (!isParticipant(task, user.id) && !(await hasPermission(user.id, 'crm.customers.view'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }
        const body = await taskDocumentStorage.read(document.fileRef);
        res.status(200).json({
            id: document.id,
            fileName: document.fileName,
            contentType: document.contentType,
            sizeBytes: document.sizeBytes,
            createdAt: document.createdAt,
            data: `data:${document.contentType};base64,${body.toString('base64')}`,
        });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** DELETE /crm/tasks/documents/:documentId — Beteiligte oder crm.activities.create. */
router.delete('/tasks/documents/:documentId', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const document = await prisma.crmTaskDocument.findFirst({
            where: { id: String(req.params.documentId || ''), tenantId: user.tenantId },
            select: { id: true, taskId: true, fileRef: true },
        });
        if (!document) return res.status(404).json({ error: 'Anhang nicht gefunden.' });
        const task = await loadTaskCore(document.taskId, user.tenantId);
        if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        if (!isParticipant(task, user.id) && !(await hasPermission(user.id, 'crm.activities.create'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }
        // `deleteMany` zählt statt zu werfen: ein zweiter Klick auf denselben
        // Papierkorb findet die Zeile ebenfalls, und null Treffer heisst nur,
        // dass jemand schneller war — das Ziel ist erreicht.
        await prisma.crmTaskDocument.deleteMany({ where: { id: document.id, tenantId: user.tenantId } });
        await taskDocumentStorage.remove(document.fileRef).catch(() => undefined);
        res.status(204).send();
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** POST /crm/tasks/:id/notes — { text, images?: dataUrl[] } — Beteiligte oder crm.activities.create. */
router.post('/tasks/:id/notes', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const existing = await loadTaskCore(String(req.params.id || ''), user.tenantId);
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        if (!isParticipant(existing, user.id) && !(await hasPermission(user.id, 'crm.activities.create'))) {
            return res.status(403).json({ error: 'Keine Berechtigung für diese Aufgabe.' });
        }
        const text = String(req.body?.text || '').trim();
        const images = sanitizeImages(req.body?.images);
        if (!text && images.length === 0) return res.status(400).json({ error: 'Notiz oder Bild erforderlich.' });
        const note = await prisma.crmTaskNote.create({
            data: { id: nanoid(12), tenantId: user.tenantId, taskId: existing.id, authorEmployeeId: user.id, text, images },
            include: { author: { select: { id: true, firstName: true, lastName: true } } },
        });
        res.status(201).json(noteRow(note));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** DELETE /crm/tasks/:id/notes/:noteId — nur die Verfasserin (oder crm.activities.create). */
router.delete('/tasks/:id/notes/:noteId', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const note = await prisma.crmTaskNote.findFirst({
            where: { id: String(req.params.noteId || ''), taskId: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true, authorEmployeeId: true },
        });
        if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden.' });
        if (note.authorEmployeeId !== user.id && !(await hasPermission(user.id, 'crm.activities.create'))) {
            return res.status(403).json({ error: 'Nur die Verfasserin kann diese Notiz löschen.' });
        }
        await prisma.crmTaskNote.delete({ where: { id: note.id } });
        res.status(200).json({ message: 'Notiz gelöscht.' });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /crm/tasks/:id
router.delete('/tasks/:id', requireAuth, requirePermission('crm.activities.create'), async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const existing = await prisma.crmTask.findFirst({ where: { id: String(req.params.id || ''), tenantId: user.tenantId }, select: { id: true } });
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        await prisma.crmTask.delete({ where: { id: existing.id } });
        res.status(200).json({ message: 'Aufgabe gelöscht.' });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
