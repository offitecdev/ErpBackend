import { nanoid } from "nanoid";
import { invalidateEverywhere } from "../cache/cacheStore";
import prisma from "../database/prisma.client";
import { AddProjectReportUseCase } from "../../application/use-cases/project/AddProjectReportUseCase";
import { ProjectReportRepository } from "../repositories/ProjectReportRepository";
import { ProjectRepository } from "../repositories/ProjectRepository";
import { appointmentDayOverWhere, appointmentDayTodayWhere } from "../../shared/appointmentDay";
import { roleLabelId } from "../../application/services/calendarLabelCatalog";

let started = false;

const startOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

const endOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};

const projectReportRepository = new ProjectReportRepository();
const addProjectReportUseCase = new AddProjectReportUseCase(
    projectReportRepository as any,
    new ProjectRepository() as any
);

const taskTechnicianIds = (task: any) => [
    task.assignedTechId,
    task.alternativeTechId,
    ...((task.assignments || []).map((assignment: any) => assignment.technicianId)),
].filter(Boolean);

const runReminderPass = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const tasks = await (prisma as any).maintenanceTask.findMany({
        where: {
            status: { not: "CANCELLED" },
            reminderSentAt: null,
            scheduledStartTime: { gte: now, lte: in24Hours },
            contract: { deletedAt: null },
        },
        include: {
            assignments: true,
            contract: { include: { customer: { select: { companyName: true } } } },
        },
        take: 100,
    });

    const notifications: any[] = [];
    const taskIds: string[] = [];
    for (const task of tasks) {
        const technicianIds = [...new Set(taskTechnicianIds(task))];
        for (const technicianId of technicianIds) {
            notifications.push({
                id: nanoid(12),
                tenantId: task.contract.tenantId,
                recipientEmployeeId: technicianId,
                type: "MAINTENANCE_REMINDER",
                title: "Yarın bakım randevunuz var",
                message: `${task.contract.contractCode} ${task.contract.customer?.companyName || ""} bakım randevusu yaklaşıyor.`,
                linkUrl: "/maintenance/technician",
                metadata: { taskId: task.id },
            });
        }
        taskIds.push(task.id);
    }

    // One bulk insert + one bulk update instead of a query per technician/task.
    if (notifications.length) {
        await (prisma as any).notification.createMany({ data: notifications });
    }
    if (taskIds.length) {
        await (prisma as any).maintenanceTask.updateMany({
            where: { id: { in: taskIds } },
            data: { reminderSentAt: new Date() },
        });
    }
};

const runProjectInstallationReminderPass = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const appointments = await (prisma as any).appointment.findMany({
        where: {
            projectId: { not: null },
            assignedTechId: { not: null },
            status: "BOOKED",
            installationReminderSentAt: null,
            startTime: { gte: now, lte: in24Hours },
        },
        include: {
            project: { include: { customer: { select: { companyName: true } } } },
            salesOrder: { select: { orderNumber: true } },
        },
        take: 100,
    });

    const notifications = appointments.map((appointment: any) => ({
        id: nanoid(12),
        tenantId: appointment.tenantId,
        recipientEmployeeId: appointment.assignedTechId,
        type: "PROJECT_INSTALLATION_REMINDER",
        title: "Yarin montaj randevunuz var",
        message: `${appointment.project?.projectName || "Proje"} ${appointment.salesOrder?.orderNumber || ""} montaji yaklasiyor.`,
        linkUrl: "/projects/installation/calendar",
        metadata: { projectId: appointment.projectId, appointmentId: appointment.id, salesOrderId: appointment.salesOrderId },
    }));
    const appointmentIds = appointments.map((appointment: any) => appointment.id);

    // One bulk insert + one bulk update instead of a query per appointment.
    if (notifications.length) {
        await (prisma as any).notification.createMany({ data: notifications });
    }
    if (appointmentIds.length) {
        await (prisma as any).appointment.updateMany({
            where: { id: { in: appointmentIds } },
            data: { installationReminderSentAt: new Date() },
        });
    }
};

/**
 * DER TAG IST VORBEI ⇒ DER TERMIN IST ABGESCHLOSSEN.
 *
 * Vorgabe Samet (03.09.2026): «Vergangene Tage sollen von selbst auf
 * Abgeschlossen springen — sobald der Tag zu Ende ist.» Ein abgeschlossener
 * Termin steht einem neuen nicht mehr im Weg (appointmentSeries.ts,
 * assertDaysAvailable), ein geplanter oder laufender schon — deshalb muss der
 * Wechsel ZUVERLÄSSIG kommen, sonst sperrt der gestrige Tag heute früh noch
 * den Kalender.
 *
 * Und er kommt UM MITTERNACHT, weil sich dann der TAG ändert — und der Tag
 * entscheidet (shared/appointmentDay.ts): gestern wird vorbei und damit
 * abgeschlossen (hier), heute wird laufend (runMarkTodayOngoingPass). Ein
 * Termin, der für einen vergangenen Tag NACHGETRAGEN wird, ist schon beim
 * Anlegen abgeschlossen (Vorgabe Samet, 03.09.2026: «ein Termin vom 31. August
 * darf am 3. September nicht als laufend dastehen»); der Durchgang holt nur
 * nach, was seit dem Schreiben weiterging. Beim Start läuft er einmal, für
 * eine verpasste Nacht.
 *
 * «Vorbei» heisst: der Termin ist zu Ende UND der Tag, an dem er begann, ist
 * um. Beides, damit eine Nachtmontage von 20:00 bis 02:00 (EIN Termin über
 * Mitternacht) nicht um 00:00 abgeschlossen wird, während noch gearbeitet wird.
 *
 * Bis heute hing der Wechsel am automatischen Tagesrapport — und der konnte
 * auf drei Arten still ausbleiben: ohne Monteur wurde die Zeile übersprungen
 * (für immer), ein fehlgeschlagener Rapport liess sie BOOKED (für immer), und
 * beides sammelte sich in den 200 Zeilen des Durchgangs, bis für frische
 * Termine kein Platz mehr war. Seither ist der Wechsel vom Rapport GETRENNT:
 * der Rapport bleibt ein Versuch je Zeile (nur mit Monteur, Fehler werden
 * protokolliert), der Wechsel geschieht danach für ALLE geladenen Zeilen in
 * einem Schritt. Was dabei ohne Rapport abgeschlossen wird, kann der Monteur
 * weiterhin von Hand nachtragen — completeInstallation weist einen
 * abgeschlossenen Termin nicht ab.
 */
const runAutoFinishInstallationPass = async () => {
    const now = new Date();

    const appointments = await (prisma as any).appointment.findMany({
        where: {
            projectId: { not: null },
            status: "BOOKED",
            // Dieselbe Frage «ist der Tag vorbei?» wie beim Schreiben eines
            // Termins — aus EINER Quelle (shared/appointmentDay.ts).
            ...appointmentDayOverWhere(now),
        },
        include: {
            technicianAssignments: { select: { technicianId: true } },
            project: { include: { salesOrders: { orderBy: { createdAt: "asc" }, select: { id: true } } } },
        },
        // Älteste zuerst: ein Rückstand wird von vorn abgetragen, statt dass
        // dieselben Zeilen jeden Durchgang aufs Neue die Plätze belegen.
        orderBy: { startTime: "asc" },
        take: 200,
    });
    if (!appointments.length) return;

    for (const appointment of appointments) {
        try {
            const dayEnd = endOfDay(new Date(appointment.startTime));

            // Ohne Monteur gibt es niemanden, dem ein Rapport gehören könnte —
            // der Tag wird trotzdem unten abgeschlossen.
            const employeeId = appointment.assignedTechId || appointment.technicianAssignments?.[0]?.technicianId || null;
            if (!employeeId) continue;

            const workDate = startOfDay(new Date(appointment.startTime));
            const orders = appointment.project?.salesOrders || [];
            const isPrimaryOrder = (orders[0]?.id || null) === (appointment.salesOrderId || null);
            const existingReport = await projectReportRepository.findByProjectAndWorkDate(
                appointment.projectId,
                workDate,
                appointment.salesOrderId ?? undefined,
                isPrimaryOrder
            );

            const reportRow = existingReport
                ? existingReport
                : await addProjectReportUseCase.execute({
                    projectId: appointment.projectId,
                    salesOrderId: appointment.salesOrderId || null,
                    appointmentId: appointment.id,
                    employeeId,
                    workDate: workDate.toISOString(),
                    startedAt: new Date(appointment.startTime).toISOString(),
                    endedAt: dayEnd.toISOString(),
                    operationsDone: "Saha çalışması gün sonunda otomatik olarak tamamlandı.",
                });

            // End-of-day auto-approval: if no administrator approved the worked hours by 23:59,
            // approve them automatically. updateMany guards against overriding a manual approval.
            if ((reportRow as any)?.id) {
                await (prisma as any).projectReport.updateMany({
                    where: { id: (reportRow as any).id, hoursApprovedAt: null },
                    data: { hoursApprovedAt: new Date(), autoApproved: true },
                });
            }
        } catch (error) {
            // Nur der Rapport ist gescheitert; der Tag wird unten trotzdem geschlossen.
            console.error("[project-installation-autofinish] report", appointment.id, error);
        }
    }

    /* DER WECHSEL — für alle geladenen Zeilen auf einmal, unabhängig davon,
       was der Rapport oben tat. `status: "BOOKED"` in der Bedingung: wer den
       Termin währenddessen von Hand abgeschlossen oder abgesagt hat, behält
       das. */
    await (prisma as any).appointment.updateMany({
        where: { id: { in: appointments.map((appointment: any) => appointment.id) }, status: "BOOKED" },
        data: { status: "COMPLETED" },
    });
};

/**
 * DAS ETIKETT NACHFÜHREN (03.09.2026).
 *
 * Vorgabe Samet: «Auf dem Kalender muss man den Abschluss SEHEN — eine Karte
 * an einem vergangenen Tag ist von selbst als abgeschlossen markiert.» Die
 * Farbe der Karte ist ihr Etikett; ein abgeschlossener Termin, der noch
 * «geplant», «laufend» oder gar kein Etikett trägt, bekommt das der Rolle
 * DONE. Dieselbe Regel wie beim Schreiben eines einzelnen Termins
 * (completedLabelPatch) — hier gebündelt, und damit auch für den BESTAND:
 * alles, was vor heute abgeschlossen wurde, wechselt beim ersten Durchgang.
 * Ein von Hand gewähltes Farbetikett bleibt; ein Mandant ohne sichtbares
 * DONE-Etikett wird übersprungen.
 */
const runRelabelCompletedPass = async () => {
    const rows = await (prisma as any).appointment.findMany({
        where: {
            projectId: { not: null },
            status: "COMPLETED",
            OR: [
                { labelId: null },
                { label: { role: { in: ["PLANNED", "ONGOING"] } } },
            ],
        },
        select: { id: true, tenantId: true },
        orderBy: { startTime: "asc" },
        take: 500,
    });
    if (!rows.length) return;

    const byTenant = new Map<string, string[]>();
    for (const row of rows) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) || []), row.id]);
    for (const [tenantId, ids] of byTenant) {
        const done = await roleLabelId(tenantId, "DONE");
        if (!done) continue;
        await (prisma as any).appointment.updateMany({ where: { id: { in: ids } }, data: { labelId: done } });
    }
};

/**
 * HEUTE ⇒ LAUFEND (03.09.2026).
 *
 * Vorgabe Samet: «Ein Termin, der heute angelegt wird, bleibt laufend, bis
 * der Tag zu Ende ist.» Was gestern noch «geplant» war und heute dran ist,
 * wechselt um Mitternacht auf das Etikett der Rolle ONGOING — dieselbe Regel
 * wie beim Anlegen (labelRoleForAppointmentDay), hier für den Bestand.
 *
 * Läuft NACH dem Tagesabschluss: dann sind die offenen Zeilen, die vor morgen
 * beginnen, genau die heutigen (und eine Nachtmontage von gestern, die noch
 * nicht zu Ende ist). Ein von Hand gewähltes Farbetikett bleibt; getauscht
 * wird nur «geplant» oder gar keines.
 */
const runMarkTodayOngoingPass = async () => {
    const rows = await (prisma as any).appointment.findMany({
        where: {
            projectId: { not: null },
            status: "BOOKED",
            ...appointmentDayTodayWhere(new Date()),
            OR: [
                { labelId: null },
                { label: { role: "PLANNED" } },
            ],
        },
        select: { id: true, tenantId: true },
        take: 500,
    });
    if (!rows.length) return;

    const byTenant = new Map<string, string[]>();
    for (const row of rows) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) || []), row.id]);
    for (const [tenantId, ids] of byTenant) {
        const ongoing = await roleLabelId(tenantId, "ONGOING");
        if (!ongoing) continue;
        await (prisma as any).appointment.updateMany({ where: { id: { in: ids } }, data: { labelId: ongoing } });
    }
};

/**
 * UM MITTERNACHT — und danach jede Nacht wieder. Kein fester 24-Stunden-Takt:
 * der würde an der Zeitumstellung um eine Stunde wandern. Nach jedem Durchgang
 * wird der nächste Tagesbeginn neu ausgerechnet (30 Sekunden Gnadenfrist, damit
 * die Uhr sicher im neuen Tag steht).
 */
const msUntilNextMidnight = () => {
    const next = new Date();
    next.setHours(24, 0, 30, 0);
    return Math.max(1000, next.getTime() - Date.now());
};

const everyMidnight = (run: () => void) => {
    const tick = () => {
        run();
        setTimeout(tick, msUntilNextMidnight());
    };
    setTimeout(tick, msUntilNextMidnight());
};

export const startMaintenanceReminderService = () => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === "true") return;
    started = true;
    // Die Erinnerungen dürfen stündlich laufen — «morgen ist Montage» hat keine Eile.
    const runReminders = () => {
        void Promise.all([
            runReminderPass().catch((error) => console.error("[maintenance-reminders]", error)),
            runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error)),
        ]).then(() => invalidateEverywhere(["calendar", "tasks"]));
    };
    /* Erst abschliessen, dann etikettieren — so trägt ein eben geschlossener
       Tag im selben Durchgang schon die richtige Farbe. */
    const runAutoFinish = () =>
        void runAutoFinishInstallationPass()
            .catch((error) => console.error("[project-installation-autofinish]", error))
            .then(() => runRelabelCompletedPass())
            .catch((error) => console.error("[project-installation-relabel]", error))
            .then(() => runMarkTodayOngoingPass())
            .catch((error) => console.error("[project-installation-ongoing]", error))
            // Termine wurden abgeschlossen und umetikettiert — Kalender-Lesespeicher neu.
            .then(() => invalidateEverywhere(["calendar", "tasks"]));
    runReminders();
    // Einmal beim Start (eine verpasste Nacht nachholen), dann jede Mitternacht.
    runAutoFinish();
    setInterval(runReminders, 60 * 60 * 1000);
    everyMidnight(runAutoFinish);
};
