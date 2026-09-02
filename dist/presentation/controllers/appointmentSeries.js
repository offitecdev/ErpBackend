"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.documentListSelect = exports.sanitizeDocumentUpload = exports.SERIES_DOCUMENT_LIMIT_BYTES = exports.DOCUMENT_LIMIT_BYTES = exports.DOCUMENT_TYPES = exports.renumberSeries = exports.seriesDays = exports.ensureSeriesId = exports.createSeries = exports.assertDaysAvailable = exports.parseAppointmentDays = exports.localDayKey = exports.blocksPlannedDays = exports.MAX_SERIES_DAYS = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
const technicianSchedule_1 = require("./technicianSchedule");
/**
 * MEHRTÄGIGE EINSÄTZE (24.08.2026).
 *
 * Vorgabe Samet: «Termine sollen über mehrere aufeinanderfolgende Tage gehen
 * können — drei, vier Tage am Stück —, jeder Tag mit eigenen Uhrzeiten, damit
 * die Überstunden weiter stimmen. Man soll mehrere Tage auf einmal wählen oder
 * einen bestehenden Termin auf weitere Tage ausdehnen können.»
 *
 * DIE ENTSCHEIDUNG DAHINTER: ein Einsatz über vier Tage ist NICHT eine Zeile
 * von Montag 08:00 bis Donnerstag 17:00. Er ist VIER ZEILEN — je Tag eine —,
 * zusammengehalten von einer gemeinsamen `seriesId`. Das ist keine Formsache:
 *
 *   · Der Tagesrapport hängt am Termin (ProjectReport.appointmentId). Ein
 *     Balken über vier Tage hätte EINEN Rapport für vier Arbeitstage.
 *   · Die Überstunden entstehen aus den geplanten Minuten EINES Tages
 *     (AddProjectReportUseCase). Über vier Tage gerechnet käme dabei Unsinn
 *     heraus.
 *   · Das Kalenderraster, die Montageliste und die Technikerplanung fragen
 *     immer nach einem Tag. Alles davon müsste sonst umgebaut werden.
 *
 * Nach aussen — Fenster, Mail, Unterlagen — spricht das Programm trotzdem von
 * EINEM Einsatz: die Serie ist die Klammer, der Tag die Arbeitseinheit.
 */
/** Mehr als ein Monat am Stück ist kein Einsatz mehr, sondern ein Versehen. */
exports.MAX_SERIES_DAYS = 31;
const fail = (message, status = 400, extra) => Object.assign(new Error(message), { status, ...(extra || {}) });
const replaceableRows = (rows) => rows
    .filter((row) => row.status !== "COMPLETED")
    .map((row) => ({ id: String(row.id), startTime: row.startTime, endTime: row.endTime }));
/**
 * Steht diese Zeile den geplanten Tagen WIRKLICH im Weg?
 *
 * Der Riegel unter `replaceAppointmentIds`: gelöscht werden darf nur, was auf
 * einem der geplanten Tage liegt. Ohne ihn könnte ein Aufruf beim Anlegen eines
 * Termins irgendeine andere Zeile mitnehmen — die Kennungen kommen zwar aus der
 * Absage des Servers, aber der Server soll sich darauf nicht verlassen müssen.
 *
 * Die zwei Fälle sind dieselben, die auch blockieren: derselbe ANFANGSTAG (die
 * Kundenregel «ein Termin je Tag») oder eine echte ÜBERLAPPUNG (die Auftrags-
 * regel). Jede blockierende Zeile erfüllt eines davon — der Riegel weist also
 * nie einen berechtigten Fall ab.
 */
const blocksPlannedDays = (row, days) => {
    const start = new Date(row.startTime);
    const end = new Date(row.endTime);
    return days.some((day) => ((0, exports.localDayKey)(start) === (0, exports.localDayKey)(day.startTime)
        || (start.getTime() < day.endTime.getTime() && end.getTime() > day.startTime.getTime())));
};
exports.blocksPlannedDays = blocksPlannedDays;
const startOfDay = (date) => {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
};
const endOfDay = (date) => {
    const day = new Date(date);
    day.setHours(23, 59, 59, 999);
    return day;
};
/** "2026-08-24" in der Zeitzone des Servers — der Schlüssel, an dem ein Tag hängt. */
const localDayKey = (date) => {
    const day = new Date(date);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};
exports.localDayKey = localDayKey;
const formatDay = (date) => new Date(date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });
/**
 * Die Tage aus dem Antwortkörper. Zwei Formen, damit nichts umgeschrieben
 * werden muss, was heute schon läuft:
 *   · `days: [{ startTime, endTime, appointmentId? }, …]` — der mehrtägige Einsatz.
 *   · `startTime` / `endTime` — der einzelne Tag, wie bisher.
 *
 * Geprüft wird, was einen Einsatztag zu einem Einsatztag macht: Ende nach
 * Anfang, höchstens 24 Stunden am Stück (eine Nachtschicht über Mitternacht ist
 * ausdrücklich EIN Tag, siehe PlannedDay) und kein ANFANGSTAG zweimal — zwei
 * Zeilen, die am selben Tag beginnen, wären zwei Rapporte für einen Arbeitstag.
 */
const parseAppointmentDays = (body) => {
    const raw = Array.isArray(body?.days) && body.days.length
        ? body.days
        : [{ startTime: body?.startTime, endTime: body?.endTime, appointmentId: body?.appointmentId }];
    if (raw.length > exports.MAX_SERIES_DAYS) {
        throw fail(`Ein Einsatz umfasst höchstens ${exports.MAX_SERIES_DAYS} Tage.`);
    }
    const days = raw.map((entry) => {
        const startTime = new Date(entry?.startTime);
        const endTime = new Date(entry?.endTime);
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
            throw fail("Geben Sie für jeden Tag eine gültige Anfangs- und Endzeit an.");
        }
        // Über Mitternacht ist erlaubt und bleibt EIN Termin; 24 Stunden am
        // Stück sind die Grenze — darüber ist es ein zweiter Einsatztag.
        if (endTime.getTime() - startTime.getTime() > 24 * 60 * 60_000) {
            throw fail("Ein Einsatztag dauert höchstens 24 Stunden. Für den Folgetag legen Sie einen weiteren Tag an.");
        }
        return {
            startTime,
            endTime,
            appointmentId: entry?.appointmentId ? String(entry.appointmentId) : undefined,
        };
    });
    days.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const seen = new Set();
    for (const day of days) {
        const key = (0, exports.localDayKey)(day.startTime);
        if (seen.has(key))
            throw fail(`Für den ${formatDay(day.startTime)} sind zwei Zeiten angegeben. Je Tag gilt eine Arbeitszeit.`);
        seen.add(key);
    }
    // Zwei Tage dürfen sich nicht überlappen — sonst hätte eine Nachtschicht
    // ihren eigenen Folgetag aufgefressen.
    for (let index = 1; index < days.length; index += 1) {
        if (days[index].startTime.getTime() < days[index - 1].endTime.getTime()) {
            throw fail(`Der ${formatDay(days[index].startTime)} beginnt, bevor der Tag davor zu Ende ist.`);
        }
    }
    return days;
};
exports.parseAppointmentDays = parseAppointmentDays;
/**
 * Prüft ALLE Tage auf einmal, bevor auch nur einer geschrieben wird. Ein
 * halb angelegter Einsatz — Montag und Dienstag stehen, Mittwoch ist besetzt —
 * wäre schlimmer als eine klare Absage.
 *
 * Die drei Fragen sind dieselben wie beim einzelnen Termin, nur für mehrere
 * Tage und parallel gestellt (die Datenbank liegt entfernt; hintereinander
 * wären es bei vier Tagen zwölf Wartezeiten).
 */
const assertDaysAvailable = async (input) => {
    const exclude = [...new Set((input.excludeAppointmentIds || []).filter(Boolean))];
    const notSelf = exclude.length ? { id: { notIn: exclude } } : {};
    const dayWindows = input.days.map((day) => ({
        gte: startOfDay(day.startTime),
        lte: endOfDay(day.startTime),
    }));
    /* ALLE belegten Zeilen, nicht nur die erste (01.09.2026): der Knopf
       «löschen und speichern» muss den ganzen Weg freiräumen können. Bei vier
       geplanten Tagen stehen sonst vier Absagen hintereinander an. */
    const blockerSelect = { id: true, startTime: true, endTime: true, status: true };
    const [customerHits, projectHits, technicianHits] = await Promise.all([
        // Ein Kunde bekommt je Kalendertag EINEN Einsatztermin — dieselbe Regel
        // wie beim einzelnen Termin, nur für alle gewählten Tage zugleich.
        input.customerId
            ? prisma_client_1.default.appointment.findMany({
                where: {
                    customerId: input.customerId,
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    ...notSelf,
                    OR: dayWindows.map((window) => ({ startTime: window })),
                },
                orderBy: { startTime: "asc" },
                select: blockerSelect,
            })
            : Promise.resolve([]),
        // Derselbe Auftrag darf sich nicht selbst überlappen.
        prisma_client_1.default.appointment.findMany({
            where: {
                projectId: input.projectId,
                ...(input.salesOrderId !== undefined ? { salesOrderId: input.salesOrderId } : {}),
                ...notSelf,
                OR: input.days.map((day) => ({
                    startTime: { lt: day.endTime },
                    endTime: { gt: day.startTime },
                })),
            },
            orderBy: { startTime: "asc" },
            select: blockerSelect,
        }),
        Promise.all(input.days.map((day) => (0, technicianSchedule_1.findTechnicianScheduleConflict)(input.technicianIds, day.startTime, day.endTime, input.tenantId, {
            appointmentIds: exclude,
        }).then((conflict) => (conflict ? { day, conflict } : null)))),
    ]);
    if (customerHits.length) {
        throw fail(`Für diesen Kunden besteht am ${formatDay(customerHits[0].startTime)} bereits ein Termin. Je Tag ist ein Termin möglich.`, 409, { replaceable: replaceableRows(customerHits) });
    }
    if (projectHits.length) {
        throw fail(`Der Zeitplan dieses Auftrags überschneidet sich am ${formatDay(projectHits[0].startTime)}.`, 409, { replaceable: replaceableRows(projectHits) });
    }
    const technicianHit = technicianHits.find(Boolean);
    if (technicianHit) {
        throw fail(`${formatDay(technicianHit.day.startTime)}: ${technicianHit.conflict.message}`, 409);
    }
};
exports.assertDaysAvailable = assertDaysAvailable;
/* ── Die Serie ──────────────────────────────────────────────────────────── */
/**
 * Die Klammer um die Tage. Auch ein EINTÄGIGER Termin bekommt eine — dann
 * hängen «Terminunterlagen» und «weitere Tage anhängen» überall gleich, ohne
 * dass beim ersten Anhängen erst etwas umgebaut werden müsste.
 */
const createSeries = async (tx, tenantId, coverNote) => {
    const id = (0, nanoid_1.nanoid)(10);
    await tx.appointmentSeries.create({
        data: { id, tenantId, coverNote: coverNote?.trim() || null },
    });
    return id;
};
exports.createSeries = createSeries;
/**
 * Die Serie eines Termins — für Zeilen von vor dem 24.08.2026 wird sie beim
 * ersten Zugriff nachgetragen. Nachträglich anlegen ist hier richtig: die
 * Serie beschreibt nichts, was der alte Termin nicht schon wäre (ein Einsatz
 * mit einem Tag), und ohne sie liesse sich an ihm keine Unterlage ablegen.
 */
const ensureSeriesId = async (appointment) => {
    if (appointment.seriesId)
        return appointment.seriesId;
    return await prisma_client_1.default.$transaction(async (tx) => {
        const seriesId = await (0, exports.createSeries)(tx, appointment.tenantId);
        await tx.appointment.update({
            where: { id: appointment.id },
            data: { seriesId, dayIndex: 0 },
        });
        return seriesId;
    });
};
exports.ensureSeriesId = ensureSeriesId;
/** Die Tage einer Serie in ihrer Reihenfolge — die Antwort auf «Tag 2 von 4». */
const seriesDays = async (seriesId, tenantId) => await prisma_client_1.default.appointment.findMany({
    where: { seriesId, tenantId },
    orderBy: { startTime: "asc" },
    select: {
        id: true,
        dayIndex: true,
        startTime: true,
        endTime: true,
        status: true,
        projectId: true,
        salesOrderId: true,
    },
});
exports.seriesDays = seriesDays;
/**
 * Nach jeder Änderung an den Tagen wird durchnummeriert. `dayIndex` ist die
 * Nummer IM Einsatz, nicht das Datum — fällt der Dienstag weg, ist der Mittwoch
 * ab sofort «Tag 2», und die Mail sagt dasselbe wie der Bildschirm.
 */
const renumberSeries = async (tx, seriesId) => {
    const days = await tx.appointment.findMany({
        where: { seriesId },
        orderBy: { startTime: "asc" },
        select: { id: true, dayIndex: true },
    });
    await Promise.all(days.map((day, index) => (day.dayIndex === index
        ? Promise.resolve(null)
        : tx.appointment.update({ where: { id: day.id }, data: { dayIndex: index } }))));
};
exports.renumberSeries = renumberSeries;
/* ── Terminunterlagen ──────────────────────────────────────────────────── */
/**
 * Was als Unterlage an einem Termin hängen darf: der Begleitzettel (PDF), Fotos
 * und Zeichnungen. Sie gehen NIE an den Kunden — sie stehen nur im Programm
 * unter «Terminunterlagen» und auf dem Bildschirm der Monteurin.
 */
exports.DOCUMENT_TYPES = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/heic",
]);
/* Je Datei 12 MB — ein Bauplan als PDF liegt darunter, ein Film nicht. Seit die
   Datei ROH reist (multipart, 24.08.2026) und nicht mehr als Base64 in einem
   JSON-Körper, ist der Briefumschlag nicht mehr die Grenze. */
exports.DOCUMENT_LIMIT_BYTES = 12 * 1024 * 1024;
/** Und je Einsatz höchstens 60 MB, damit die Zeile ladbar bleibt. */
exports.SERIES_DOCUMENT_LIMIT_BYTES = 60 * 1024 * 1024;
const base64Bytes = (value) => Math.floor(String(value || "").replace(/\s+/g, "").length * 3 / 4);
/**
 * Was der Browser schickt, in eine ablegbare Datei verwandelt.
 *
 * DER SCHNELLE WEG ZUERST (24.08.2026): eine ROHE Datei aus einem
 * multipart-Formular (`req.file`) — dasselbe, was der Angebotsanhang tut. Kein
 * Base64, keine Umkodierung, kein aufgeblähter JSON-Körper.
 *
 * Der zweite Weg ist eine Daten-URI im Körper. Er bleibt für Aufrufer, die
 * keine Datei zur Hand haben (Skripte, künftige Fremdsysteme) — er ist
 * langsamer, und das ist in Ordnung, solange die Oberfläche ihn nicht geht.
 */
const sanitizeDocumentUpload = (raw, file) => {
    const fileName = String(file?.originalname || raw?.fileName || "").trim().replace(/[\r\n]/g, " ").slice(0, 180);
    if (!fileName)
        throw fail("Eine Unterlage braucht einen Dateinamen.");
    if (file?.buffer) {
        const contentType = String(file.mimetype || raw?.contentType || "").trim().toLowerCase();
        if (!exports.DOCUMENT_TYPES.has(contentType))
            throw fail("Als Unterlage sind PDF und Bilder möglich.");
        if (!file.buffer.length)
            throw fail("Die Unterlage ist leer.");
        if (file.buffer.length > exports.DOCUMENT_LIMIT_BYTES) {
            throw fail(`Eine Unterlage darf höchstens ${Math.round(exports.DOCUMENT_LIMIT_BYTES / (1024 * 1024))} MB gross sein.`);
        }
        return { fileName, contentType, sizeBytes: file.buffer.length, body: file.buffer };
    }
    const rawData = String(raw?.data ?? "").trim();
    if (!rawData)
        throw fail("Eine Unterlage braucht einen Inhalt.");
    const dataUri = /^data:([^;,]+);base64,/i.exec(rawData);
    const contentType = String(raw?.contentType || dataUri?.[1] || "").trim().toLowerCase();
    if (!exports.DOCUMENT_TYPES.has(contentType))
        throw fail("Als Unterlage sind PDF und Bilder möglich.");
    const payload = (dataUri ? rawData.slice(rawData.indexOf(",") + 1) : rawData).replace(/\s+/g, "");
    const sizeBytes = base64Bytes(payload);
    if (!sizeBytes)
        throw fail("Die Unterlage ist leer.");
    if (sizeBytes > exports.DOCUMENT_LIMIT_BYTES) {
        throw fail(`Eine Unterlage darf höchstens ${Math.round(exports.DOCUMENT_LIMIT_BYTES / (1024 * 1024))} MB gross sein.`);
    }
    return { fileName, contentType, sizeBytes, body: Buffer.from(payload, "base64") };
};
exports.sanitizeDocumentUpload = sanitizeDocumentUpload;
/** Die Liste zeigt Namen, Typ und Grösse — der Inhalt wird erst beim Öffnen geholt. */
exports.documentListSelect = {
    id: true,
    fileName: true,
    contentType: true,
    sizeBytes: true,
    fileRef: true,
    createdAt: true,
    uploadedBy: { select: { id: true, firstName: true, lastName: true } },
};
//# sourceMappingURL=appointmentSeries.js.map