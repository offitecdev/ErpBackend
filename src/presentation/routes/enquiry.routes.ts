import { Router } from "express";
import { Prisma } from "@prisma/client";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requirePermission } from "../middlewares/RbacMiddleware";
import { rateLimit } from "../middlewares/RateLimitMiddleware";
import prisma from "../../infrastructure/database/prisma.client";

/* ANFRAGEN (10.09.2026, Vorgabe Samet) — der Kontakt VOR dem Kunden.

   Eine Anfrage kommt auf drei Wegen herein und ist danach EIN Vorgang:
     FORM   das oeffentliche Formular (`/anfrage/<token>`, ohne Anmeldung)
     MAIL   eine Nachricht, die im Postfach der Kategorie «Anfragen» zugeordnet
            wurde (siehe enquiryFromMail.ts)
     MANUAL von Hand erfasst

   WARUM SIE KEINEN KUNDEN BRAUCHT: «das sind im Allgemeinen Leute, die nicht im
   System sind und uns erreichen wollen». Firma, Name, Mail und Telefon stehen
   deshalb AN DER ANFRAGE. `customerId` ist eine spaetere Verbindung — entweder
   automatisch beim Eingang (die Adresse gehoert einem bekannten Kunden) oder
   von Hand ueber «zum Kunden machen».

   RECHTE: dieselben CRM-Schluessel wie ueberall im Modul (crm.customers.view /
   crm.activities.create). Ein neuer Rechteschluessel waere auf allen
   bestehenden Rollen unbelegt und damit fuer alle 403 — siehe crm.routes.ts.

   PERFORMANCE: die Liste ist EIN geschriebenes Statement plus die Zaehlung,
   parallel abgesetzt. Prisma-`include` haette je Verknuepfung eine weitere
   Runde zur entfernten Datenbank gekostet. */

const router = Router();

const STATUSES = new Set(["NEW", "IN_PROGRESS", "ANSWERED", "CONVERTED", "CLOSED", "SPAM"]);
const SOURCES = new Set(["FORM", "MAIL", "MANUAL"]);
const PRIORITIES = new Set(["LOW", "NORMAL", "HIGH"]);
/** Staende, die als "offen" gelten — der Punkt im Menue und die Kachel zaehlen sie. */
const OPEN_STATUSES = ["NEW", "IN_PROGRESS"];

const READ = requirePermission("crm.customers.view");
const WRITE = requirePermission("crm.activities.create");

/* Das oeffentliche Formular ist der einzige unangemeldete Weg in die Datenbank.
   Es ist darum gedeckelt: eine Handvoll Sendungen je Viertelstunde und IP
   reicht fuer echte Anfragen und nicht fuer einen Fluter. Das Lesen der
   Formularbeschreibung ist grosszuegiger — es schreibt nichts. */
const publicSubmitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    message: "Zu viele Anfragen. Bitte versuchen Sie es spaeter erneut.",
});
const publicReadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });

const parsePage = (req: { query: Record<string, unknown> }) => {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "25"), 10) || 25));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

const parseDate = (raw: unknown): Date | null => {
    if (!raw) return null;
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? null : date;
};

const text = (value: unknown, max: number): string | null => {
    const trimmed = String(value ?? "").trim();
    return trimmed ? trimmed.slice(0, max) : null;
};

/** Grobe Adresspruefung — sie haelt Tippfehler ab, nicht Betrueger. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const personOrNull = (id: unknown, first: unknown, last: unknown) =>
    id ? { id: String(id), firstName: String(first ?? ""), lastName: String(last ?? "") } : null;

/** Die Zeile, wie die Liste und das Fenster sie lesen. */
const rowDto = (row: Record<string, any>) => ({
    id: row.id,
    source: row.source,
    status: row.status,
    priority: row.priority,
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    address: row.address,
    addressSupplement: row.addressSupplement,
    postalCode: row.postalCode,
    city: row.city,
    state: row.state,
    country: row.country,
    subject: row.subject,
    message: row.message ?? null,
    internalNote: row.internalNote ?? null,
    customer: row.customerId ? { id: row.customerId, companyName: row.customerName ?? null } : null,
    mailMessageId: row.mailMessageId ?? null,
    tenderId: row.tenderId ?? null,
    assignee: personOrNull(row.assignedEmployeeId, row.assigneeFirstName, row.assigneeLastName),
    createdBy: personOrNull(row.createdByEmployeeId, row.creatorFirstName, row.creatorLastName),
    answeredAt: row.answeredAt ?? null,
    closedAt: row.closedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

/* ── Das oeffentliche Formular je Mandant ─────────────────────────────────────
   Es wird beim ersten Lesen angelegt, damit auf der Anfragenseite sofort ein
   Link steht — niemand soll erst "Formular erstellen" druecken muessen. */

const newToken = () => crypto.randomBytes(24).toString("base64url");

const ensureForm = async (tenantId: string) => {
    const existing = await prisma.enquiryForm.findUnique({ where: { tenantId } });
    if (existing) return existing;
    try {
        return await prisma.enquiryForm.create({
            data: { id: nanoid(12), tenantId, token: newToken(), active: true },
        });
    } catch {
        // Wettlauf zweier Reiter: einer gewinnt, der andere liest ihn.
        return prisma.enquiryForm.findUniqueOrThrow({ where: { tenantId } });
    }
};

const formDto = (form: {
    token: string; active: boolean; title: string | null; intro: string | null;
    thanks: string | null; fieldRules: unknown; notifyEmails: unknown;
}) => ({
    token: form.token,
    // Der Pfad, nicht die volle Adresse: welcher Server das ERP ausliefert,
    // weiss der Browser besser als der Server (Reverse-Proxy, eigene Domain).
    path: `/anfrage/${form.token}`,
    active: form.active,
    title: form.title,
    intro: form.intro,
    thanks: form.thanks,
    fieldRules: form.fieldRules ?? null,
    notifyEmails: Array.isArray(form.notifyEmails) ? form.notifyEmails : [],
});

/**
 * GET /enquiries — die Liste.
 * Filter: status, source, assignedEmployeeId, search (Firma/Name/Mail/Betreff),
 * from/to ueber createdAt. `status=OPEN` ist die Abkuerzung fuer NEW+IN_PROGRESS.
 */
router.get("/", requireAuth, READ, async (req, res) => {
    try {
        const user = req.user!;
        const { page, pageSize, skip, take } = parsePage(req);
        const statusRaw = String(req.query.status || "").trim().toUpperCase();
        const source = String(req.query.source || "").trim().toUpperCase();
        const assignedEmployeeId = String(req.query.assignedEmployeeId || "").trim();
        const search = String(req.query.search || "").trim();
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);

        const where: Prisma.Sql[] = [Prisma.sql`e.tenantId = ${user.tenantId}`];
        if (statusRaw === "OPEN") where.push(Prisma.sql`e.status IN (${Prisma.join(OPEN_STATUSES)})`);
        else if (STATUSES.has(statusRaw)) where.push(Prisma.sql`e.status = ${statusRaw}`);
        if (SOURCES.has(source)) where.push(Prisma.sql`e.source = ${source}`);
        if (assignedEmployeeId) where.push(Prisma.sql`e.assignedEmployeeId = ${assignedEmployeeId}`);
        if (from) where.push(Prisma.sql`e.createdAt >= ${from}`);
        if (to) where.push(Prisma.sql`e.createdAt <= ${to}`);
        if (search) {
            const like = `%${search}%`;
            where.push(Prisma.sql`(e.companyName LIKE ${like} OR e.contactName LIKE ${like} OR e.email LIKE ${like} OR e.subject LIKE ${like})`);
        }
        const whereSql = Prisma.join(where, " AND ");

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT e.*, cu.companyName AS customerName,
                       a.firstName AS assigneeFirstName, a.lastName AS assigneeLastName,
                       c.firstName AS creatorFirstName, c.lastName AS creatorLastName
                  FROM Enquiry e
                  LEFT JOIN Customer cu ON cu.id = e.customerId
                  LEFT JOIN Employee a ON a.id = e.assignedEmployeeId
                  LEFT JOIN Employee c ON c.id = e.createdByEmployeeId
                 WHERE ${whereSql}
                 ORDER BY e.createdAt DESC, e.id DESC
                 LIMIT ${take} OFFSET ${skip}
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                SELECT COUNT(*) AS total FROM Enquiry e WHERE ${whereSql}
            `),
        ]);

        const total = Number(countRows[0]?.total ?? 0);
        res.json({
            data: rows.map(rowDto),
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
        });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || "Anfragen konnten nicht geladen werden." });
    }
});

/**
 * GET /enquiries/stats — die Zaehler je Stand in EINER Abfrage.
 * `open` traegt der Punkt im Menue; die Kacheln ueber der Liste lesen den Rest.
 */
router.get("/stats", requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const rows = await prisma.enquiry.groupBy({
            by: ["status"],
            where: { tenantId },
            _count: { _all: true },
        });
        const byStatus: Record<string, number> = {};
        for (const row of rows) byStatus[row.status] = row._count._all;
        res.json({
            byStatus,
            total: rows.reduce((sum, row) => sum + row._count._all, 0),
            open: OPEN_STATUSES.reduce((sum, status) => sum + (byStatus[status] || 0), 0),
            unread: byStatus.NEW || 0,
        });
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

/* ── Das Formular: Link, Texte, Meldeadressen ────────────────────────────── */

router.get("/form", requireAuth, READ, async (req, res) => {
    try {
        res.json(formDto(await ensureForm(req.user!.tenantId)));
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

router.patch("/form", requireAuth, WRITE, async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        await ensureForm(tenantId);
        const data: Prisma.EnquiryFormUncheckedUpdateInput = {};
        if (req.body?.active !== undefined) data.active = Boolean(req.body.active);
        if (req.body?.title !== undefined) data.title = text(req.body.title, 200);
        if (req.body?.intro !== undefined) data.intro = text(req.body.intro, 4000);
        if (req.body?.thanks !== undefined) data.thanks = text(req.body.thanks, 2000);
        if (req.body?.notifyEmails !== undefined) {
            const list = Array.isArray(req.body.notifyEmails) ? req.body.notifyEmails : [];
            data.notifyEmails = list
                .map((entry: unknown) => String(entry || "").trim())
                .filter((entry: string) => EMAIL_RE.test(entry))
                .slice(0, 10);
        }
        const updated = await prisma.enquiryForm.update({ where: { tenantId }, data });
        res.json(formDto(updated));
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

/** Neuer Token — der alte Link ist danach tot. Bewusst eine eigene Aktion. */
router.post("/form/rotate", requireAuth, WRITE, async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        await ensureForm(tenantId);
        const updated = await prisma.enquiryForm.update({ where: { tenantId }, data: { token: newToken() } });
        res.json(formDto(updated));
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

/* ── Eine einzelne Anfrage ───────────────────────────────────────────────── */

const loadOne = async (id: string, tenantId: string) => {
    const rows = await prisma.$queryRaw<Array<Record<string, any>>>`
        SELECT e.*, cu.companyName AS customerName,
               a.firstName AS assigneeFirstName, a.lastName AS assigneeLastName,
               c.firstName AS creatorFirstName, c.lastName AS creatorLastName
          FROM Enquiry e
          LEFT JOIN Customer cu ON cu.id = e.customerId
          LEFT JOIN Employee a ON a.id = e.assignedEmployeeId
          LEFT JOIN Employee c ON c.id = e.createdByEmployeeId
         WHERE e.id = ${id} AND e.tenantId = ${tenantId}
         LIMIT 1`;
    return rows[0] || null;
};

router.get("/:id", requireAuth, READ, async (req, res) => {
    try {
        const row = await loadOne(String(req.params.id), req.user!.tenantId);
        if (!row) return res.status(404).json({ error: "Anfrage nicht gefunden." });
        res.json(rowDto(row));
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

/** POST /enquiries — von Hand erfasst (Telefon, Messe, Empfehlung …). */
router.post("/", requireAuth, WRITE, async (req, res) => {
    try {
        const user = req.user!;
        const subject = text(req.body?.subject, 300);
        if (!subject) return res.status(400).json({ error: "Betreff fehlt." });

        const customerId = text(req.body?.customerId, 191);
        if (customerId) {
            const customer = await prisma.customer.findFirst({
                where: { id: customerId, tenantId: user.tenantId }, select: { id: true },
            });
            if (!customer) return res.status(404).json({ error: "Kunde nicht gefunden." });
        }

        const status = String(req.body?.status || "").toUpperCase();
        const priority = String(req.body?.priority || "").toUpperCase();

        const created = await prisma.enquiry.create({
            data: {
                id: nanoid(12),
                tenantId: user.tenantId,
                source: "MANUAL",
                status: STATUSES.has(status) ? status : "NEW",
                priority: PRIORITIES.has(priority) ? priority : "NORMAL",
                companyName: text(req.body?.companyName, 200),
                contactName: text(req.body?.contactName, 160),
                email: text(req.body?.email, 255),
                phone: text(req.body?.phone, 64),
                address: text(req.body?.address, 255),
                addressSupplement: text(req.body?.addressSupplement, 255),
                postalCode: text(req.body?.postalCode, 32),
                city: text(req.body?.city, 120),
                state: text(req.body?.state, 120),
                country: text(req.body?.country, 120),
                subject,
                message: text(req.body?.message, 20_000),
                internalNote: text(req.body?.internalNote, 8000),
                customerId: customerId || null,
                assignedEmployeeId: text(req.body?.assignedEmployeeId, 191),
                createdByEmployeeId: user.id,
            },
            select: { id: true },
        });
        res.status(201).json(rowDto((await loadOne(created.id, user.tenantId))!));
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

/**
 * PATCH /enquiries/:id — Stand, Verantwortliche, Kontaktdaten, Notiz.
 *
 * `answeredAt`/`closedAt` setzt der Server aus dem Stand: sie sind ABGELEITET,
 * damit die Zeitpunkte nicht auseinanderlaufen, wenn jemand den Stand zweimal
 * aendert.
 */
router.patch("/:id", requireAuth, WRITE, async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id);
        const existing = await prisma.enquiry.findFirst({
            where: { id, tenantId: user.tenantId }, select: { id: true },
        });
        if (!existing) return res.status(404).json({ error: "Anfrage nicht gefunden." });

        const data: Prisma.EnquiryUncheckedUpdateInput = {};
        const setText = (field: string, key: string, max: number) => {
            if (req.body?.[key] !== undefined) (data as any)[field] = text(req.body[key], max);
        };
        setText("companyName", "companyName", 200);
        setText("contactName", "contactName", 160);
        setText("email", "email", 255);
        setText("phone", "phone", 64);
        setText("address", "address", 255);
        setText("addressSupplement", "addressSupplement", 255);
        setText("postalCode", "postalCode", 32);
        setText("city", "city", 120);
        setText("state", "state", 120);
        setText("country", "country", 120);
        setText("message", "message", 20_000);
        setText("internalNote", "internalNote", 8000);
        // Der Betreff ist Pflicht: ein geleertes Feld darf ihn nicht loeschen.
        if (req.body?.subject !== undefined) {
            const subject = text(req.body.subject, 300);
            if (!subject) return res.status(400).json({ error: "Betreff fehlt." });
            data.subject = subject;
        }

        if (req.body?.priority !== undefined) {
            const priority = String(req.body.priority || "").toUpperCase();
            if (!PRIORITIES.has(priority)) return res.status(400).json({ error: "Prioritaet unbekannt." });
            data.priority = priority;
        }
        if (req.body?.assignedEmployeeId !== undefined) {
            data.assignedEmployeeId = text(req.body.assignedEmployeeId, 191);
        }
        if (req.body?.customerId !== undefined) {
            const customerId = text(req.body.customerId, 191);
            if (customerId) {
                const customer = await prisma.customer.findFirst({
                    where: { id: customerId, tenantId: user.tenantId }, select: { id: true },
                });
                if (!customer) return res.status(404).json({ error: "Kunde nicht gefunden." });
            }
            data.customerId = customerId;
        }
        if (req.body?.status !== undefined) {
            const status = String(req.body.status || "").toUpperCase();
            if (!STATUSES.has(status)) return res.status(400).json({ error: "Stand unbekannt." });
            data.status = status;
            // Beantwortet/abgeschlossen tragen ihren Zeitpunkt; ein Rueckschritt
            // auf einen offenen Stand raeumt ihn wieder ab.
            data.answeredAt = ["ANSWERED", "CONVERTED", "CLOSED"].includes(status) ? new Date() : null;
            data.closedAt = ["CLOSED", "CONVERTED", "SPAM"].includes(status) ? new Date() : null;
        }

        await prisma.enquiry.update({ where: { id }, data });
        res.json(rowDto((await loadOne(id, user.tenantId))!));
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

/**
 * POST /enquiries/:id/convert — aus der Anfrage einen KUNDEN machen.
 *
 * Die Anfrage bleibt bestehen und bekommt den Stand CONVERTED plus die
 * Verbindung zum neuen Kunden: sie ist der Beleg, wie der Kunde zu uns kam.
 * Steht schon ein Kunde daran, wird kein zweiter angelegt.
 */
router.post("/:id/convert", requireAuth, requirePermission("crm.customers.create"), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id);
        const enquiry = await prisma.enquiry.findFirst({ where: { id, tenantId: user.tenantId } });
        if (!enquiry) return res.status(404).json({ error: "Anfrage nicht gefunden." });
        if (enquiry.customerId) {
            return res.status(409).json({
                error: "Diese Anfrage haengt bereits an einem Kunden.",
                customerId: enquiry.customerId,
            });
        }

        const companyName = text(req.body?.companyName, 200)
            || enquiry.companyName || enquiry.contactName || enquiry.email;
        if (!companyName) return res.status(400).json({ error: "Ohne Firma oder Name laesst sich kein Kunde anlegen." });

        // Vor- und Nachname der verantwortlichen Person aus dem Namen der
        // Anfrage: alles vor dem letzten Leerzeichen ist der Vorname.
        const contact = (enquiry.contactName || "").trim();
        const cut = contact.lastIndexOf(" ");
        const firstName = cut > 0 ? contact.slice(0, cut) : contact;
        const lastName = cut > 0 ? contact.slice(cut + 1) : "";

        const customer = await prisma.customer.create({
            data: {
                id: nanoid(8),
                tenantId: user.tenantId,
                companyName,
                customerType: text(req.body?.customerType, 16) || "PRIVATE",
                address: enquiry.address,
                addressSupplement: enquiry.addressSupplement,
                postalCode: enquiry.postalCode,
                city: enquiry.city,
                state: enquiry.state,
                country: enquiry.country,
                mainEmail: enquiry.email,
                mainPhone: enquiry.phone,
                responsibleFirstName: firstName || null,
                responsibleLastName: lastName || null,
                customerSource: enquiry.source === "FORM" ? "Anfrageformular" : enquiry.source === "MAIL" ? "E-Mail" : "Anfrage",
                status: "ACTIVE",
            },
            select: { id: true, companyName: true },
        });

        await prisma.enquiry.update({
            where: { id },
            data: { customerId: customer.id, status: "CONVERTED", answeredAt: new Date(), closedAt: new Date() },
        });

        res.status(201).json({ customer, enquiry: rowDto((await loadOne(id, user.tenantId))!) });
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

router.delete("/:id", requireAuth, WRITE, async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id);
        const existing = await prisma.enquiry.findFirst({
            where: { id, tenantId: user.tenantId }, select: { id: true },
        });
        if (!existing) return res.status(404).json({ error: "Anfrage nicht gefunden." });
        await prisma.enquiry.delete({ where: { id } });
        res.status(204).send();
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

export default router;

/* ─────────────────────────────────────────────────────────────────────────────
   DAS OEFFENTLICHE FORMULAR — eigener Router, eigener Pfad (/public/enquiry).
   Er haengt NICHT unter /enquiries, damit kein Weg hier versehentlich ohne
   `requireAuth` neben den angemeldeten steht: was oeffentlich ist, steht in
   diesem Block und nirgends sonst.
   ───────────────────────────────────────────────────────────────────────── */

export const publicEnquiryRouter = Router();

/** Beschreibung des Formulars — Titel, Einleitung, Feldregeln, Firmenname. */
publicEnquiryRouter.get("/:token", publicReadLimiter, async (req, res) => {
    try {
        const form = await prisma.enquiryForm.findUnique({
            where: { token: String(req.params.token) },
            select: {
                active: true, title: true, intro: true, fieldRules: true,
                tenant: { select: { tenantName: true } },
            },
        });
        // Ein abgeschaltetes Formular verhaelt sich wie ein unbekanntes: der Link
        // soll nicht verraten, dass es ihn einmal gab.
        if (!form || !form.active) return res.status(404).json({ error: "Dieses Formular ist nicht (mehr) verfuegbar." });
        res.json({
            companyName: form.tenant?.tenantName || null,
            title: form.title,
            intro: form.intro,
            fieldRules: form.fieldRules ?? null,
        });
    } catch {
        res.status(404).json({ error: "Dieses Formular ist nicht (mehr) verfuegbar." });
    }
});

/** Absenden. Antwortet bewusst knapp — es gibt hier nichts auszulesen. */
publicEnquiryRouter.post("/:token", publicSubmitLimiter, async (req, res) => {
    try {
        const form = await prisma.enquiryForm.findUnique({
            where: { token: String(req.params.token) },
            select: { tenantId: true, active: true, thanks: true },
        });
        if (!form || !form.active) return res.status(404).json({ error: "Dieses Formular ist nicht (mehr) verfuegbar." });

        // Honigtopf: ein Feld, das kein Mensch sieht und jeder Fluter ausfuellt.
        // Die Antwort ist trotzdem freundlich — wer es war, soll nicht lernen,
        // woran er erkannt wurde.
        if (text(req.body?.website, 200)) return res.status(201).json({ ok: true, thanks: form.thanks || null });

        const email = text(req.body?.email, 255);
        const subject = text(req.body?.subject, 300);
        const message = text(req.body?.message, 20_000);
        if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Bitte eine gueltige E-Mail-Adresse angeben." });
        if (!subject) return res.status(400).json({ error: "Bitte einen Betreff angeben." });
        if (!message) return res.status(400).json({ error: "Bitte eine Nachricht schreiben." });

        // Ist die Adresse bekannt, haengt die Anfrage gleich am richtigen Kunden —
        // sonst bleibt sie kundenlos, und das ist der Normalfall.
        const known = await prisma.customer.findFirst({
            where: { tenantId: form.tenantId, mainEmail: email },
            select: { id: true },
        });

        await prisma.enquiry.create({
            data: {
                id: nanoid(12),
                tenantId: form.tenantId,
                source: "FORM",
                status: "NEW",
                companyName: text(req.body?.companyName, 200),
                contactName: text(req.body?.contactName, 160),
                email,
                phone: text(req.body?.phone, 64),
                address: text(req.body?.address, 255),
                postalCode: text(req.body?.postalCode, 32),
                city: text(req.body?.city, 120),
                country: text(req.body?.country, 120),
                subject,
                message,
                customerId: known?.id ?? null,
                submittedIp: String(req.ip || "").slice(0, 64) || null,
            },
        });

        res.status(201).json({ ok: true, thanks: form.thanks || null });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || "Die Anfrage konnte nicht gespeichert werden." });
    }
});
