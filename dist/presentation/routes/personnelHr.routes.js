"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ── PERSONALAKTE, FEIERTAGE UND ARBEITSZEITERFASSUNG (26.08.2026) ────────────
 *
 * Ein ZWEITER Router auf demselben Pfad `/personnel` — dieselbe Bauweise wie
 * bei den Berechtigungen unter `/employees`. Der Personal-Router davor kennt
 * `/staff/:id/overview`, `/leaves` und die Rapporte; die Wege hier sind
 * durchweg anders benannt und kollidieren deshalb nicht.
 *
 * WAS HIER LIEGT:
 *   /staff/:id/profile        Stammdaten der Akte (lesen + ändern)
 *   /staff/:id/documents      Arbeitsvertrag (genau einer) und Unterlagen
 *   /staff/:id/leave-year     Urlaubskonto, Feiertage, Abwesenheiten
 *   /staff/:id/time-log       Arbeitszeitnachweis der Person
 *   /time-records             Die Arbeitszeiterfassung über ALLE Personen
 *   /holidays                 Die geführten Feiertage + der amtliche Katalog
 *   /leave-policy             Die Urlaubsregel des Hauses
 *
 * TENANT-BEREICH: wie im Personal-Router — Personal gehört der AUSGEWÄHLTEN
 * Firma (getPersonnelTenantScope, seit 31.08.2026); Schwesterfirmen sehen
 * einander nicht. Schichtplan, Urlaubsregel und Feiertage hängen weiterhin am
 * STAMM des Baums: sie sind eine Regel des Hauses, keine der einzelnen Firma,
 * und dürfen sich beim Firmenumschalter nicht ändern.
 */
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const tenantTree_1 = require("../../shared/tenantTree");
const LocalFileStorage_1 = require("../../infrastructure/services/LocalFileStorage");
const staffDirectoryCache_1 = require("../../shared/staffDirectoryCache");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const publicHolidays_1 = require("../../shared/publicHolidays");
const personnel_1 = require("../../shared/personnel");
const personnelProfile_1 = require("../../application/services/personnelProfile");
const personnelReports_1 = require("../../application/services/personnelReports");
const router = (0, express_1.Router)();
const roleRepo = new RoleRepository_1.RoleRepository();
/* Die Unterlagen reisen ROH (multipart) — derselbe Weg wie Angebots- und
   Terminunterlagen. Ein Arbeitsvertrag als Scan wiegt schnell ein paar MB;
   12 MB ist dieselbe Grenze wie bei den Terminunterlagen. */
const staffDocumentUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 10 },
});
const fail = (res, status, message) => res.status(status).json({ error: message });
/** Die Firmen, aus denen PERSONEN gelesen werden: genau die ausgewählte. */
const treeOf = (req) => (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
/** Der Stamm des Firmenbaums — dort hängen Schichtplan, Feiertage, Urlaubsregel.
    Diese Regeln bleiben BAUMWEIT: sie gehören dem Haus, nicht der einzelnen
    Firma, und dürfen sich beim Firmenumschalter nicht ändern. */
const houseTenantId = async (req) => (await (0, tenantTree_1.findTenantRootIdCached)(req.user.tenantId)) ?? req.user.tenantId;
const loadShiftPlan = async (tenantId) => {
    const row = await prisma_client_1.default.staffShiftPlan.findUnique({ where: { tenantId } });
    if (!row)
        return { ...personnel_1.DEFAULT_SHIFT_PLAN };
    return (0, personnel_1.parseShiftPlan)({
        workdays: row.workdaysJson,
        startTime: row.startTime,
        endTime: row.endTime,
        breakMinutes: row.breakMinutes,
    });
};
const loadLeavePolicy = async (tenantId) => {
    const row = await prisma_client_1.default.staffLeavePolicy.findUnique({ where: { tenantId } });
    return row ? (0, personnel_1.parseLeavePolicy)(row) : { ...personnel_1.DEFAULT_LEAVE_POLICY };
};
/**
 * Darf der Aufrufer die Personalakte DIESER Person sehen bzw. ändern?
 * Die eigene Akte steht jeder Person offen; eine fremde braucht das Recht.
 * Geändert werden die Stammdaten NUR mit Verwaltungsrecht — auch die eigenen
 * (Vorgabe: «Systemrolle, Vor- und Nachname darf nur die Verwaltung ändern»).
 */
const accessFor = async (req, employeeId) => {
    const user = req.user;
    const isSelf = employeeId === user.id;
    const permissions = await roleRepo.getEmployeePermissions(user.id);
    const canManage = permissions.includes('employees.update') || permissions.includes('roles.manage');
    const canRead = isSelf || canManage || permissions.includes('employees.view');
    return { isSelf, canRead, canManage, permissions };
};
// ─────────────────────────────────────────────────────────────────────────────
// Urlaubsregel (Einstellungen → Module → Personal)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/leave-policy', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        res.status(200).json({ policy: await loadLeavePolicy(await houseTenantId(req)) });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
router.put('/leave-policy', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        const policy = (0, personnel_1.parseLeavePolicy)(req.body);
        const saved = await prisma_client_1.default.staffLeavePolicy.upsert({
            where: { tenantId },
            create: { id: (0, nanoid_1.nanoid)(), tenantId, ...policy },
            update: policy,
        });
        res.status(200).json({ policy: (0, personnel_1.parseLeavePolicy)(saved) });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Feiertage
// ─────────────────────────────────────────────────────────────────────────────
const holidayDto = (row) => ({
    id: row.id,
    date: (0, personnel_1.toDateKey)(new Date(row.date)),
    name: row.name,
    catalogKey: row.catalogKey,
    countryCode: row.countryCode,
    religious: row.religious,
    halfDay: row.halfDay,
});
/**
 * GET /personnel/holidays?year=2026
 * Die GEFÜHRTEN Feiertage des Jahres und daneben der amtliche Katalog, aus dem
 * sich einer auswählen lässt. Beides in EINEM Aufruf: die Auswahlliste muss
 * wissen, was schon übernommen ist, sonst böte sie dieselben Tage doppelt an.
 */
router.get('/holidays', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const year = Math.trunc(Number(req.query.year)) || new Date().getFullYear();
        const country = String(req.query.country || 'TR').toUpperCase().slice(0, 2);
        const tenantId = await houseTenantId(req);
        const rows = await (0, personnelProfile_1.loadHolidays)(tenantId, new Date(year, 0, 1), new Date(year, 11, 31, 23, 59, 59, 999));
        res.status(200).json({
            year,
            country,
            holidays: rows.map(holidayDto),
            catalog: (0, publicHolidays_1.holidayCatalog)(year, country),
            catalogYears: (0, publicHolidays_1.holidayCatalogYears)(),
        });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
router.post('/holidays', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        const date = (0, personnel_1.parseDateOnly)(req.body?.date);
        if (!date)
            return fail(res, 400, 'Datum ist ungültig.');
        const name = String(req.body?.name ?? '').trim().slice(0, 120);
        if (!name)
            return fail(res, 400, 'Bitte den Feiertag benennen.');
        /* `upsert` auf (Mandant, Tag, Name): zweimal auf denselben Knopf zu
           drücken darf keinen zweiten Eintrag machen — und keine 500. */
        const saved = await prisma_client_1.default.publicHoliday.upsert({
            where: { tenantId_date_name: { tenantId, date: (0, personnel_1.startOfDay)(date), name } },
            create: {
                id: (0, nanoid_1.nanoid)(),
                tenantId,
                date: (0, personnel_1.startOfDay)(date),
                name,
                catalogKey: String(req.body?.catalogKey ?? '').trim() || null,
                countryCode: String(req.body?.countryCode || 'TR').toUpperCase().slice(0, 2),
                religious: Boolean(req.body?.religious),
                halfDay: Boolean(req.body?.halfDay),
            },
            update: {
                catalogKey: String(req.body?.catalogKey ?? '').trim() || null,
                religious: Boolean(req.body?.religious),
                halfDay: Boolean(req.body?.halfDay),
            },
        });
        res.status(201).json(holidayDto(saved));
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/** Mehrere Katalogtage auf einmal übernehmen («alle amtlichen Tage des Jahres»). */
router.post('/holidays/bulk', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
        if (!rows.length)
            return fail(res, 400, 'Keine Feiertage übergeben.');
        const data = rows
            .map((row) => {
            const date = (0, personnel_1.parseDateOnly)(row?.date);
            const name = String(row?.name ?? '').trim().slice(0, 120);
            if (!date || !name)
                return null;
            return {
                id: (0, nanoid_1.nanoid)(),
                tenantId,
                date: (0, personnel_1.startOfDay)(date),
                name,
                catalogKey: String(row?.catalogKey ?? '').trim() || null,
                countryCode: String(row?.countryCode || 'TR').toUpperCase().slice(0, 2),
                religious: Boolean(row?.religious),
                halfDay: Boolean(row?.halfDay),
            };
        })
            .filter(Boolean);
        if (!data.length)
            return fail(res, 400, 'Keine gültige Zeile dabei.');
        // `skipDuplicates`: was schon geführt wird, bleibt unverändert stehen.
        await prisma_client_1.default.publicHoliday.createMany({ data, skipDuplicates: true });
        const years = [...new Set(data.map((row) => new Date(row.date).getFullYear()))];
        const saved = await prisma_client_1.default.publicHoliday.findMany({
            where: {
                tenantId,
                date: {
                    gte: new Date(Math.min(...years), 0, 1),
                    lte: new Date(Math.max(...years), 11, 31, 23, 59, 59, 999),
                },
            },
            orderBy: { date: 'asc' },
        });
        res.status(201).json({ holidays: saved.map(holidayDto) });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
router.delete('/holidays/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        // `deleteMany`, nicht `delete`: ein zweiter Klick auf denselben
        // Papierkorb soll das Ziel bestätigen, nicht mit P2025 scheitern.
        await prisma_client_1.default.publicHoliday.deleteMany({ where: { id: String(req.params.id), tenantId } });
        res.status(204).end();
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Personalakte: Stammdaten
// ─────────────────────────────────────────────────────────────────────────────
const documentDto = (row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
});
/**
 * GET /personnel/staff/:id/profile — der Reiter «Profil» in EINEM Aufruf.
 *
 * Er trägt genau das, was die Vorgabe aufzählt: Stammdaten, Arbeits-E-Mail,
 * Arbeitstelefon, Vor- und Nachname, Systemrolle — änderbar NUR durch die
 * Verwaltung —, dazu der Arbeitsvertrag und die übrigen Unterlagen.
 */
router.get('/staff/:id/profile', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const access = await accessFor(req, id);
        if (!access.canRead)
            return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');
        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0)
            return fail(res, 404, 'Person nicht gefunden.');
        const [person, documents, roles] = await Promise.all([
            prisma_client_1.default.employee.findFirst({
                where: { id, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
                select: {
                    id: true, staffNumber: true, firstName: true, lastName: true,
                    email: true, phone: true, title: true, isActive: true,
                    staffRole: true, workLocation: true, hireDate: true, terminationDate: true,
                    createdAt: true, profilePictureUrl: true, roleName: true,
                    employeeRoles: {
                        take: 1,
                        select: { role: { select: { id: true, roleName: true, isSystemAdmin: true } } },
                    },
                },
            }),
            prisma_client_1.default.staffDocument.findMany({
                where: { employeeId: id },
                orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
                select: {
                    id: true, kind: true, title: true, fileName: true,
                    contentType: true, sizeBytes: true, createdAt: true,
                },
            }),
            // Die Auswahlliste der Systemrollen — nur die Verwaltung sieht sie.
            access.canManage
                ? prisma_client_1.default.role.findMany({
                    // Rollen bleiben baumweit sichtbar, siehe role.routes.ts.
                    where: { tenantId: { in: tenantIds } },
                    select: { id: true, roleName: true },
                    orderBy: { roleName: 'asc' },
                })
                : Promise.resolve([]),
        ]);
        if (!person)
            return fail(res, 404, 'Person nicht gefunden.');
        const assigned = person.employeeRoles?.[0]?.role ?? null;
        const contract = documents.find((row) => row.kind === 'CONTRACT') ?? null;
        res.status(200).json({
            person: {
                id: person.id,
                staffNumber: person.staffNumber,
                firstName: person.firstName,
                lastName: person.lastName,
                email: person.email,
                phone: person.phone,
                title: person.title,
                isActive: person.isActive,
                staffRole: person.staffRole,
                workLocation: person.workLocation,
                hireDate: person.hireDate,
                terminationDate: person.terminationDate,
                createdAt: person.createdAt,
                profilePictureUrl: person.profilePictureUrl,
                roleId: assigned?.id ?? null,
                roleName: assigned?.roleName ?? person.roleName ?? null,
                isSystemAdminRole: Boolean(assigned?.isSystemAdmin),
            },
            canEdit: access.canManage,
            isSelf: access.isSelf,
            roles: roles.map((role) => ({ id: role.id, name: role.roleName })),
            contract: contract ? documentDto(contract) : null,
            documents: documents.filter((row) => row.kind !== 'CONTRACT').map(documentDto),
        });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/**
 * PATCH /personnel/staff/:id/profile — die Stammdaten ändern.
 *
 * NUR die Verwaltung (Vorgabe): Arbeits-E-Mail, Arbeitstelefon, Vor- und
 * Nachname und die Systemrolle sind nichts, was jemand an sich selbst
 * verstellt. Die eigene Seite zeigt dieselben Felder, aber gesperrt.
 */
router.patch('/staff/:id/profile', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const tenantIds = await treeOf(req);
        const existing = await prisma_client_1.default.employee.findFirst({
            where: { id, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
            select: { id: true, email: true },
        });
        if (!existing)
            return fail(res, 404, 'Person nicht gefunden.');
        const data = {};
        const text = (value, max) => String(value ?? '').trim().slice(0, max);
        if (req.body?.firstName !== undefined) {
            const value = text(req.body.firstName, 100);
            if (!value)
                return fail(res, 400, 'Vorname darf nicht leer sein.');
            data.firstName = value;
        }
        if (req.body?.lastName !== undefined) {
            const value = text(req.body.lastName, 100);
            if (!value)
                return fail(res, 400, 'Nachname darf nicht leer sein.');
            data.lastName = value;
        }
        if (req.body?.email !== undefined) {
            const value = text(req.body.email, 190).toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
                return fail(res, 400, 'Arbeits-E-Mail ist ungültig.');
            if (value !== existing.email) {
                // Die Adresse IST die Anmeldung — sie muss hausweit eindeutig bleiben.
                const taken = await prisma_client_1.default.employee.findFirst({ where: { email: value }, select: { id: true } });
                if (taken && taken.id !== id)
                    return fail(res, 400, 'Diese Adresse ist bereits vergeben.');
            }
            data.email = value;
        }
        if (req.body?.phone !== undefined)
            data.phone = text(req.body.phone, 60) || null;
        if (req.body?.title !== undefined)
            data.title = text(req.body.title, 120) || null;
        if (req.body?.hireDate !== undefined) {
            const parsed = (0, personnel_1.parseDateOnly)(req.body.hireDate);
            data.hireDate = req.body.hireDate ? (parsed ? (0, personnel_1.startOfDay)(parsed) : null) : null;
        }
        if (req.body?.staffRole !== undefined) {
            if (!(0, personnel_1.isStaffRole)(req.body.staffRole))
                return fail(res, 400, 'Personalrolle ist unbekannt.');
            data.staffRole = req.body.staffRole;
        }
        if (req.body?.workLocation !== undefined) {
            if (!(0, personnel_1.isWorkLocation)(req.body.workLocation))
                return fail(res, 400, 'Arbeitsort ist unbekannt.');
            data.workLocation = req.body.workLocation;
        }
        if (Object.keys(data).length === 0)
            return fail(res, 400, 'Nichts zu ändern.');
        const saved = await prisma_client_1.default.employee.update({
            where: { id },
            data,
            select: {
                id: true, firstName: true, lastName: true, email: true, phone: true,
                title: true, staffRole: true, workLocation: true, hireDate: true,
            },
        });
        /* Der Personenverzeichnis-Zwischenspeicher hält Name und Adresse; ohne
           dieses Verwerfen zeigten Auswahllisten den alten Namen weiter. */
        (0, staffDirectoryCache_1.invalidateStaffDirectory)();
        AuditLogService_1.auditLog.log({
            action: 'personnel.profile.update',
            tenantId: req.user.tenantId,
            employeeId: req.user.id,
            entityType: 'Employee',
            entityId: id,
            metadata: { fields: Object.keys(data) },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json(saved);
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Personalakte: Arbeitsvertrag und Unterlagen
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /personnel/staff/:id/documents — eine Unterlage anhängen.
 * `kind=CONTRACT` ist der Arbeitsvertrag: es gibt genau EINEN, ein neuer
 * ersetzt den alten (samt Datei auf der Platte).
 */
router.post('/staff/:id/documents', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), staffDocumentUpload.single('file'), async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const tenantIds = await treeOf(req);
        const person = await prisma_client_1.default.employee.findFirst({
            where: { id, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
            select: { id: true, tenantId: true },
        });
        if (!person)
            return fail(res, 404, 'Person nicht gefunden.');
        const file = req.file;
        if (!file)
            return fail(res, 400, 'Keine Datei empfangen.');
        if (!LocalFileStorage_1.staffDocumentStorage.accepts(file.mimetype)) {
            return fail(res, 400, 'Diese Dateiart wird nicht angenommen (PDF, Bild, Word, Excel, Text).');
        }
        const kind = String(req.body?.kind || 'DOCUMENT') === 'CONTRACT' ? 'CONTRACT' : 'DOCUMENT';
        const title = String(req.body?.title ?? '').trim().slice(0, 200) || file.originalname;
        const fileRef = await LocalFileStorage_1.staffDocumentStorage.store(person.tenantId, file.buffer, file.mimetype);
        /* Der Vertrag ist EINER. Erst die Datei schreiben, dann die alte
           Zeile abräumen: geht das Schreiben schief, steht der bisherige
           Vertrag noch da. */
        let replaced = [];
        if (kind === 'CONTRACT') {
            replaced = await prisma_client_1.default.staffDocument.findMany({
                where: { employeeId: id, kind: 'CONTRACT' },
                select: { fileRef: true },
            });
            await prisma_client_1.default.staffDocument.deleteMany({ where: { employeeId: id, kind: 'CONTRACT' } });
        }
        const saved = await prisma_client_1.default.staffDocument.create({
            data: {
                id: (0, nanoid_1.nanoid)(),
                tenantId: person.tenantId,
                employeeId: id,
                kind,
                title,
                fileName: file.originalname,
                contentType: file.mimetype,
                sizeBytes: file.size,
                fileRef,
                uploadedById: req.user.id,
            },
            select: {
                id: true, kind: true, title: true, fileName: true,
                contentType: true, sizeBytes: true, createdAt: true,
            },
        });
        // Die verdrängten Dateien liegen sonst für immer auf der Platte.
        for (const old of replaced) {
            await LocalFileStorage_1.staffDocumentStorage.remove(old.fileRef).catch(() => { });
        }
        res.status(201).json(documentDto(saved));
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/** GET /personnel/documents/:documentId — der Inhalt, erst beim Öffnen. */
router.get('/documents/:documentId', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const document = await prisma_client_1.default.staffDocument.findFirst({
            where: { id: String(req.params.documentId || ''), tenantId: { in: tenantIds } },
        });
        if (!document)
            return fail(res, 404, 'Unterlage nicht gefunden.');
        const access = await accessFor(req, document.employeeId);
        if (!access.canRead)
            return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');
        const body = await LocalFileStorage_1.staffDocumentStorage.read(document.fileRef);
        res.status(200).json({
            id: document.id,
            kind: document.kind,
            title: document.title,
            fileName: document.fileName,
            contentType: document.contentType,
            sizeBytes: document.sizeBytes,
            createdAt: document.createdAt,
            data: `data:${document.contentType};base64,${body.toString('base64')}`,
        });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
router.delete('/documents/:documentId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const document = await prisma_client_1.default.staffDocument.findFirst({
            where: { id: String(req.params.documentId || ''), tenantId: { in: tenantIds } },
            select: { id: true, fileRef: true },
        });
        if (!document)
            return fail(res, 404, 'Unterlage nicht gefunden.');
        await prisma_client_1.default.staffDocument.deleteMany({ where: { id: document.id } });
        await LocalFileStorage_1.staffDocumentStorage.remove(document.fileRef).catch(() => { });
        res.status(204).end();
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Urlaubskonto und Abwesenheiten einer Person
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /personnel/staff/:id/leave-year?year=2026
 * Erworbener Anspruch, Feiertage und Abwesenheiten — der Reiter «Urlaub und
 * Abwesenheiten».
 */
router.get('/staff/:id/leave-year', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const access = await accessFor(req, id);
        if (!access.canRead)
            return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');
        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user.tenantId;
        const year = Math.trunc(Number(req.query.year)) || new Date().getFullYear();
        const person = await prisma_client_1.default.employee.findFirst({
            where: { id, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
            select: { id: true, hireDate: true, createdAt: true },
        });
        if (!person)
            return fail(res, 404, 'Person nicht gefunden.');
        const [plan, policy] = await Promise.all([loadShiftPlan(tenantId), loadLeavePolicy(tenantId)]);
        const leaveYear = await (0, personnelProfile_1.buildLeaveYear)({
            tenantIds,
            shiftPlanTenantId: tenantId,
            employeeId: id,
            year,
            plan,
            policy,
            // Der Eintritt zählt; ohne ihn die Anlage der Person.
            since: person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt),
        });
        res.status(200).json({
            ...leaveYear,
            plan,
            holidays: leaveYear.holidays.map(holidayDto),
        });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Arbeitszeitnachweis
// ─────────────────────────────────────────────────────────────────────────────
/** Die Kennzahlen, die eine Person im Zeitraum erreicht hat. */
const summarisePerson = (input) => {
    const totals = input.days.reduce((sum, day) => ({
        actual: sum.actual + day.actualWorkSeconds,
        gross: sum.gross + day.grossSeconds,
        breaks: sum.breaks + day.breakSeconds,
    }), { actual: 0, gross: 0, breaks: 0 });
    const balance = (0, personnel_1.buildAccountingBalance)(totals.actual, {
        totalDays: 0, workdays: 0, publicHolidays: 0, actualWorkdays: 0,
        dailyNetHours: input.dailyNetHours, targetHours: input.targetHours,
    });
    return {
        totals,
        totalHours: balance.totalHours,
        daysShort: balance.daysShort,
        extraDays: balance.extraDays,
        leaveDays: input.absences.filter((row) => row.kind === 'VACATION').length,
        sickDays: input.absences.filter((row) => row.kind === 'SICK').length,
    };
};
/**
 * GET /personnel/staff/:id/time-log?startDate&endDate
 *
 * Der Arbeitszeitnachweis EINER Person — der Reiter «Arbeitszeiten» der
 * Personenseite. «Wie viele Stunden hat diese Person letzten Monat insgesamt
 * gearbeitet?» ist genau dieser Aufruf mit dem Zeitraum des Vormonats; die
 * Schnellwahl (Tag/Woche/Monat/Bereich) setzt bloss die beiden Daten.
 */
router.get('/staff/:id/time-log', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const access = await accessFor(req, id);
        if (!access.canRead)
            return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');
        const start = (0, personnel_1.parseDateOnly)(req.query.startDate);
        const end = (0, personnel_1.parseDateOnly)(req.query.endDate);
        if (!start || !end || end < start)
            return fail(res, 400, 'Zeitraum ist ungültig.');
        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user.tenantId;
        const plan = await loadShiftPlan(tenantId);
        const person = await prisma_client_1.default.employee.findFirst({
            where: { id, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
            select: { id: true, staffNumber: true, firstName: true, lastName: true, email: true, hireDate: true, createdAt: true },
        });
        if (!person)
            return fail(res, 404, 'Person nicht gefunden.');
        const filters = { start: (0, personnel_1.startOfDay)(start), end: (0, personnel_1.endOfDay)(end), employeeId: id };
        const [report, holidayRows, flags] = await Promise.all([
            (0, personnelReports_1.buildDetailedReport)(tenantIds, filters, plan),
            (0, personnelProfile_1.loadHolidays)(tenantId, filters.start, filters.end),
            (0, personnelReports_1.loadLeaveFlags)([id], filters.start, filters.end),
        ]);
        const holidays = (0, personnelProfile_1.holidayIndex)(holidayRows);
        const workedDayKeys = new Set(report.days.map((day) => (0, personnel_1.toDateKey)(day.workDate)));
        const absences = (0, personnelProfile_1.buildAbsences)({
            start: filters.start,
            end: filters.end,
            plan,
            holidays,
            workedDayKeys,
            flags,
            since: person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt),
            until: new Date(),
        });
        const dailyNetHours = (0, personnel_1.round2)((0, personnel_1.netShiftMinutes)(plan) / 60);
        const workdays = (0, personnelProfile_1.workdaysWithoutHolidays)(filters.start, filters.end, plan, holidays);
        const targetHours = (0, personnel_1.round2)(workdays * dailyNetHours);
        const summary = summarisePerson({ days: report.days, absences, targetHours, dailyNetHours });
        res.status(200).json({
            person: {
                id: person.id,
                staffNumber: person.staffNumber,
                firstName: person.firstName,
                lastName: person.lastName,
                email: person.email,
            },
            plan,
            basis: {
                workdays,
                publicHolidays: holidayRows.length,
                dailyNetHours,
                targetHours,
            },
            days: report.days,
            holidays: holidayRows.map(holidayDto),
            absences,
            totals: {
                actualSeconds: summary.totals.actual,
                grossSeconds: summary.totals.gross,
                breakSeconds: summary.totals.breaks,
                totalHours: summary.totalHours,
                presentDays: workedDayKeys.size,
                absentDays: absences.length,
                daysShort: summary.daysShort,
                extraDays: summary.extraDays,
            },
        });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/**
 * GET /personnel/time-records?startDate&endDate&search=&employeeIds=a,b
 *
 * DIE ARBEITSZEITERFASSUNG (Menüpunkt 2, Vorgabe 26.08.2026): eine erweiterte
 * Suche über ALLE Mitarbeitenden. Die Seite zeigt erst nach einer Suche etwas
 * an — deshalb liefert dieser Weg NICHTS, solange kein Zeitraum steht.
 *
 * Ein Aufruf, drei Sichten: die Zusammenfassung je Person (die Liste), die
 * Tageszeilen (die Aufklappung und das PDF) und die Abwesenheiten (der Filter
 * «Fehltage»). Sie getrennt zu holen hiesse, dieselben Zeilen dreimal über
 * die Ferne zu ziehen.
 */
router.get('/time-records', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('attendance.read'), async (req, res) => {
    try {
        const start = (0, personnel_1.parseDateOnly)(req.query.startDate);
        const end = (0, personnel_1.parseDateOnly)(req.query.endDate);
        if (!start || !end || end < start)
            return fail(res, 400, 'Zeitraum ist ungültig.');
        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user.tenantId;
        const plan = await loadShiftPlan(tenantId);
        const employeeIds = String(req.query.employeeIds ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
        const staff = await (0, personnelProfile_1.loadStaffForSearch)(tenantIds, {
            search: String(req.query.search ?? ''),
            employeeIds,
        });
        if (staff.length === 0) {
            return res.status(200).json({ plan, basis: null, people: [], days: [], holidays: [] });
        }
        const filters = { start: (0, personnel_1.startOfDay)(start), end: (0, personnel_1.endOfDay)(end) };
        const staffIds = staff.map((person) => person.id);
        const [holidayRows, flags] = await Promise.all([
            (0, personnelProfile_1.loadHolidays)(tenantId, filters.start, filters.end),
            (0, personnelReports_1.loadLeaveFlags)(staffIds, filters.start, filters.end),
        ]);
        const holidays = (0, personnelProfile_1.holidayIndex)(holidayRows);
        /* Der Rapport wird EINMAL über die gesuchten Personen gebaut und danach
           je Person aufgeteilt — nicht je Person einmal gerufen. Bei vierzig
           Personen ist das der Unterschied zwischen zwei Netzwegen und achtzig.
           Die Personenliste reicht die Suche gleich mit hinein, damit nicht
           auch noch die Stempelungen aller anderen geladen werden. */
        const report = await (0, personnelReports_1.buildDetailedReport)(tenantIds, filters, plan, staff);
        const days = report.days;
        const daysByPerson = new Map();
        for (const day of days) {
            const bucket = daysByPerson.get(day.employeeId);
            if (bucket)
                bucket.push(day);
            else
                daysByPerson.set(day.employeeId, [day]);
        }
        const flagsByPerson = new Map();
        for (const flag of flags) {
            const bucket = flagsByPerson.get(flag.employeeId);
            if (bucket)
                bucket.push(flag);
            else
                flagsByPerson.set(flag.employeeId, [flag]);
        }
        const dailyNetHours = (0, personnel_1.round2)((0, personnel_1.netShiftMinutes)(plan) / 60);
        const workdays = (0, personnelProfile_1.workdaysWithoutHolidays)(filters.start, filters.end, plan, holidays);
        const targetHours = (0, personnel_1.round2)(workdays * dailyNetHours);
        const now = new Date();
        const people = staff.map((person) => {
            const personDays = daysByPerson.get(person.id) ?? [];
            const workedDayKeys = new Set(personDays.map((day) => (0, personnel_1.toDateKey)(day.workDate)));
            const absences = (0, personnelProfile_1.buildAbsences)({
                start: filters.start,
                end: filters.end,
                plan,
                holidays,
                workedDayKeys,
                flags: flagsByPerson.get(person.id) ?? [],
                since: person.createdAt,
                until: now,
            });
            const summary = summarisePerson({ days: personDays, absences, targetHours, dailyNetHours });
            return {
                employeeId: person.id,
                staffNumber: person.staffNumber,
                firstName: person.firstName,
                lastName: person.lastName,
                email: person.email,
                workLocation: person.workLocation,
                totalSeconds: summary.totals.actual,
                totalHours: summary.totalHours,
                grossSeconds: summary.totals.gross,
                breakSeconds: summary.totals.breaks,
                presentDays: workedDayKeys.size,
                absentDays: absences.length,
                leaveDays: summary.leaveDays,
                sickDays: summary.sickDays,
                targetHours,
                daysShort: summary.daysShort,
                extraDays: summary.extraDays,
            };
        });
        res.status(200).json({
            plan,
            basis: {
                workdays,
                publicHolidays: holidayRows.length,
                dailyNetHours,
                targetHours,
                totalPeople: people.length,
            },
            people,
            days,
            holidays: holidayRows.map(holidayDto),
        });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/**
 * POST /personnel/time-entries/bulk — ALTE ANWESENHEIT NACHTRAGEN
 * (27.08.2026, Vorgabe: «über die Wahl des Monats alle Tage als anwesend
 * erfassen, oder mit Von/Bis einen alten Bestand nachtragen»).
 *
 * Für jeden GEPLANTEN Arbeitstag des Zeitraums, der kein Feiertag ist, noch
 * keine Stempelung trägt und bereits VERGANGEN ist, entsteht EINE manuelle
 * Zeile mit den Planzeiten des Hauses. Was schon erfasst ist, bleibt
 * unangetastet — der Weg trägt nach, er überschreibt nie.
 */
router.post('/time-entries/bulk', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['attendance.create', 'attendance.update']), async (req, res) => {
    try {
        const employeeId = String(req.body?.employeeId || '');
        const start = (0, personnel_1.parseDateOnly)(req.body?.startDate);
        const end = (0, personnel_1.parseDateOnly)(req.body?.endDate);
        if (!employeeId)
            return fail(res, 400, 'Person fehlt.');
        if (!start || !end || end < start)
            return fail(res, 400, 'Zeitraum ist ungültig.');
        /* KEINE Zeitraumgrenze mehr (Vorgabe 27.08.2026: «beim Nachtragen gibt
           es keine Beschränkung»). Die natürliche Grenze bleibt: unterhalb des
           Eintritts und ab heute entsteht ohnehin keine Zeile. */
        const tenantIds = await treeOf(req);
        const person = await prisma_client_1.default.employee.findFirst({
            where: { id: employeeId, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
            select: { id: true, tenantId: true, hireDate: true, createdAt: true },
        });
        if (!person)
            return fail(res, 404, 'Person nicht gefunden.');
        const tenantId = await houseTenantId(req);
        const plan = await loadShiftPlan(tenantId);
        const rangeStart = (0, personnel_1.startOfDay)(start);
        const rangeEnd = (0, personnel_1.endOfDay)(end);
        const [holidayRows, existing] = await Promise.all([
            (0, personnelProfile_1.loadHolidays)(tenantId, rangeStart, rangeEnd),
            prisma_client_1.default.staffTimeEntry.findMany({
                where: { employeeId, workDate: { gte: rangeStart, lte: rangeEnd } },
                select: { workDate: true },
            }),
        ]);
        const holidays = (0, personnelProfile_1.holidayIndex)(holidayRows);
        const stamped = new Set(existing.map((row) => (0, personnel_1.toDateKey)(new Date(row.workDate))));
        const today = (0, personnel_1.startOfDay)(new Date());
        const since = (0, personnel_1.startOfDay)(person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt));
        const startMinutes = (0, personnel_1.minutesOfDay)(plan.startTime);
        const endMinutes = (0, personnel_1.minutesOfDay)(plan.endTime);
        const data = [];
        let skipped = 0;
        for (let day = rangeStart; day.getTime() <= rangeEnd.getTime(); day = (0, personnel_1.addDays)(day, 1)) {
            const key = (0, personnel_1.toDateKey)(day);
            const eligible = plan.workdays.includes((0, personnel_1.isoWeekday)(day))
                && !holidays.has(key)
                && !stamped.has(key)
                && day.getTime() < today.getTime()
                && day.getTime() >= since.getTime();
            if (!eligible) {
                skipped += 1;
                continue;
            }
            const startedAt = new Date(day.getTime() + startMinutes * 60_000);
            // Nachtschicht (Ende ≤ Beginn): das Ende liegt am Folgetag.
            const endedAt = endMinutes > startMinutes
                ? new Date(day.getTime() + endMinutes * 60_000)
                : new Date((0, personnel_1.addDays)(day, 1).getTime() + endMinutes * 60_000);
            data.push({
                id: (0, nanoid_1.nanoid)(),
                tenantId: person.tenantId,
                employeeId,
                workDate: day,
                startedAt,
                endedAt,
                durationSeconds: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
                source: 'MANUAL',
                editedById: req.user.id,
                note: 'Nachtrag',
            });
        }
        if (data.length)
            await prisma_client_1.default.staffTimeEntry.createMany({ data });
        AuditLogService_1.auditLog.log({
            action: 'personnel.timeEntry.bulkCreate',
            tenantId: req.user.tenantId,
            employeeId: req.user.id,
            entityType: 'StaffTimeEntry',
            metadata: { targetEmployeeId: employeeId, created: data.length, from: (0, personnel_1.toDateKey)(rangeStart), to: (0, personnel_1.toDateKey)(rangeEnd) },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(201).json({ created: data.length, skipped });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/**
 * POST /personnel/absences/manual — EINE ABWESENHEIT NACHTRAGEN
 * (27.08.2026, Vorgabe: «etwa beim Eintritt soll sich eine Abwesenheit über
 * einen Zeitraum manuell erfassen lassen — gerechnet ab dem Eintrittsdatum»).
 *
 * Eine Abwesenheit IST im Modell ein geplanter Arbeitstag ohne Leistung; der
 * Nachtrag legt deshalb keinen eigenen Tagesbestand an, sondern einen bereits
 * BEWILLIGTEN Antrag über den Zeitraum. Die Abwesenheitsrechnung nimmt ihn wie
 * jeden anderen: die Tage erscheinen mit dem angegebenen Grund — und nie in
 * der Arbeitszeittabelle.
 *
 * Der Beginn darf nicht vor dem Eintritt liegen: davor gab es keine
 * Arbeitspflicht, also auch keine Abwesenheit.
 */
router.post('/absences/manual', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['attendance.create', 'attendance.update', 'employees.update']), async (req, res) => {
    try {
        const employeeId = String(req.body?.employeeId || '');
        const start = (0, personnel_1.parseDateOnly)(req.body?.startDate);
        const end = (0, personnel_1.parseDateOnly)(req.body?.endDate);
        if (!employeeId)
            return fail(res, 400, 'Person fehlt.');
        if (!start || !end || end < start)
            return fail(res, 400, 'Zeitraum ist ungültig.');
        /* KEINE Zeitraumgrenze (Vorgabe 27.08.2026) — der Eintrag ist ohnehin
           auf Eintritt bis heute eingezäunt.
           HEUTE ist erlaubt (Vorfall 27.08.2026: das Formular belegt das Ende
           mit dem heutigen Tag vor, und der Vergleich auf das TAGESENDE wies
           genau diese Vorbelegung ab). Abgelehnt wird erst ein Ende MORGEN. */
        if ((0, personnel_1.startOfDay)(end).getTime() > (0, personnel_1.startOfDay)(new Date()).getTime()) {
            return fail(res, 400, 'Nachgetragen wird Vergangenes — das Ende liegt in der Zukunft.');
        }
        const tenantIds = await treeOf(req);
        const person = await prisma_client_1.default.employee.findFirst({
            where: { id: employeeId, ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds), deletedAt: null },
            select: { id: true, tenantId: true, hireDate: true, createdAt: true },
        });
        if (!person)
            return fail(res, 404, 'Person nicht gefunden.');
        const since = (0, personnel_1.startOfDay)(person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt));
        if ((0, personnel_1.startOfDay)(start).getTime() < since.getTime()) {
            return fail(res, 400, `Der Beginn liegt vor dem Eintritt (${(0, personnel_1.toDateKey)(since)}).`);
        }
        const label = String(req.body?.label ?? '').trim().slice(0, 120) || 'Abwesenheit (Nachtrag)';
        const plan = await loadShiftPlan(await houseTenantId(req));
        const now = new Date();
        const created = await prisma_client_1.default.staffLeaveRequest.create({
            data: {
                id: (0, nanoid_1.nanoid)(),
                tenantId: person.tenantId,
                employeeId,
                kind: 'LEAVE',
                leaveType: 'OTHER',
                leaveTypeLabel: label,
                startDate: (0, personnel_1.startOfDay)(start),
                endDate: (0, personnel_1.endOfDay)(end),
                totalDays: (0, personnelReports_1.leaveWorkdays)(start, end, plan),
                note: 'Nachtrag',
                // Bereits ABGESCHLOSSEN: der Nachtrag dokumentiert, er beantragt
                // nichts — er darf in keinem Postfach auftauchen.
                status: 'APPROVED',
                approverId: req.user.id,
                managerDecisionAt: now,
                managerNote: 'Nachtrag',
                accountingDecisionAt: now,
                accountingNote: 'Nachtrag',
            },
            select: { id: true, startDate: true, endDate: true, totalDays: true },
        });
        AuditLogService_1.auditLog.log({
            action: 'personnel.absence.manualCreate',
            tenantId: req.user.tenantId,
            employeeId: req.user.id,
            entityType: 'StaffLeaveRequest',
            entityId: created.id,
            metadata: { targetEmployeeId: employeeId, from: (0, personnel_1.toDateKey)(start), to: (0, personnel_1.toDateKey)(end), label },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(201).json({ id: created.id, totalDays: created.totalDays });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
/**
 * GET /personnel/absences?startDate&endDate&search=
 * Der Abwesenheitsfilter der Antragsseite («es muss alles filterbar sein»):
 * dieselbe Rechnung wie oben, aber nur die Fehltage — ohne die Tageszeilen,
 * die sie nicht braucht.
 */
router.get('/absences', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('attendance.read'), async (req, res) => {
    try {
        const start = (0, personnel_1.parseDateOnly)(req.query.startDate);
        const end = (0, personnel_1.parseDateOnly)(req.query.endDate);
        if (!start || !end || end < start)
            return fail(res, 400, 'Zeitraum ist ungültig.');
        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user.tenantId;
        const plan = await loadShiftPlan(tenantId);
        const staff = await (0, personnelProfile_1.loadStaffForSearch)(tenantIds, { search: String(req.query.search ?? '') });
        if (staff.length === 0)
            return res.status(200).json({ rows: [] });
        const filters = { start: (0, personnel_1.startOfDay)(start), end: (0, personnel_1.endOfDay)(end) };
        const staffIds = staff.map((person) => person.id);
        const [holidayRows, flags, report] = await Promise.all([
            (0, personnelProfile_1.loadHolidays)(tenantId, filters.start, filters.end),
            (0, personnelReports_1.loadLeaveFlags)(staffIds, filters.start, filters.end),
            (0, personnelReports_1.buildDetailedReport)(tenantIds, filters, plan, staff),
        ]);
        const holidays = (0, personnelProfile_1.holidayIndex)(holidayRows);
        const workedByPerson = new Map();
        for (const day of report.days) {
            const bucket = workedByPerson.get(day.employeeId) ?? new Set();
            bucket.add((0, personnel_1.toDateKey)(day.workDate));
            workedByPerson.set(day.employeeId, bucket);
        }
        const flagsByPerson = new Map();
        for (const flag of flags) {
            const bucket = flagsByPerson.get(flag.employeeId);
            if (bucket)
                bucket.push(flag);
            else
                flagsByPerson.set(flag.employeeId, [flag]);
        }
        const now = new Date();
        const rows = staff.flatMap((person) => (0, personnelProfile_1.buildAbsences)({
            start: filters.start,
            end: filters.end,
            plan,
            holidays,
            workedDayKeys: workedByPerson.get(person.id) ?? new Set(),
            flags: flagsByPerson.get(person.id) ?? [],
            since: person.createdAt,
            until: now,
        }).map((absence) => ({
            ...absence,
            employeeId: person.id,
            staffNumber: person.staffNumber,
            firstName: person.firstName,
            lastName: person.lastName,
        })));
        rows.sort((a, b) => a.date.localeCompare(b.date) || a.lastName.localeCompare(b.lastName));
        res.status(200).json({ rows });
    }
    catch (error) {
        fail(res, 400, error.message);
    }
});
exports.default = router;
//# sourceMappingURL=personnelHr.routes.js.map