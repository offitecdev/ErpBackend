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
 * TENANT-BEREICH: wie im Personal-Router — Personal gehört dem GANZEN
 * Firmenbaum (getCompanyTreeTenantIds). Schichtplan, Urlaubsregel und
 * Feiertage hängen am STAMM des Baums: sie sind eine Regel des Hauses, keine
 * der einzelnen Firma, und dürfen sich beim Firmenumschalter nicht ändern.
 */
import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { getCompanyTreeTenantIds } from '../controllers/serviceTenantScope';
import { staffDocumentStorage } from '../../infrastructure/services/LocalFileStorage';
import { invalidateStaffDirectory } from '../../shared/staffDirectoryCache';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import { holidayCatalog, holidayCatalogYears } from '../../shared/publicHolidays';
import {
    DEFAULT_LEAVE_POLICY,
    DEFAULT_SHIFT_PLAN,
    addDays,
    buildAccountingBalance,
    endOfDay,
    isStaffRole,
    isWorkLocation,
    isoWeekday,
    minutesOfDay,
    netShiftMinutes,
    parseDateOnly,
    parseLeavePolicy,
    parseShiftPlan,
    requestTypeOf,
    round2,
    roundHalf,
    startOfDay,
    toDateKey,
    type LeavePolicy,
    type ShiftPlan,
} from '../../shared/personnel';
import {
    buildAbsences,
    buildLeaveYear,
    holidayIndex,
    loadHolidays,
    loadStaffForSearch,
    workdaysWithoutHolidays,
    type TimeRecordPerson,
} from '../../application/services/personnelProfile';
import {
    buildDetailedReport,
    leaveWorkdays,
    loadLeaveFlags,
} from '../../application/services/personnelReports';

const router = Router();
const roleRepo = new RoleRepository();

/* Die Unterlagen reisen ROH (multipart) — derselbe Weg wie Angebots- und
   Terminunterlagen. Ein Arbeitsvertrag als Scan wiegt schnell ein paar MB;
   12 MB ist dieselbe Grenze wie bei den Terminunterlagen. */
const staffDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 10 },
});

const fail = (res: any, status: number, message: string) => res.status(status).json({ error: message });
const treeOf = (req: any): Promise<string[]> => getCompanyTreeTenantIds(req.user!.tenantId);

/** Der Stamm des Firmenbaums — dort hängen Schichtplan, Feiertage, Urlaubsregel. */
const houseTenantId = async (req: any): Promise<string> => {
    const tenantIds = await treeOf(req);
    return tenantIds[0] ?? req.user!.tenantId;
};

const loadShiftPlan = async (tenantId: string): Promise<ShiftPlan> => {
    const row = await prisma.staffShiftPlan.findUnique({ where: { tenantId } });
    if (!row) return { ...DEFAULT_SHIFT_PLAN };
    return parseShiftPlan({
        workdays: row.workdaysJson,
        startTime: row.startTime,
        endTime: row.endTime,
        breakMinutes: row.breakMinutes,
    });
};

const loadLeavePolicy = async (tenantId: string): Promise<LeavePolicy> => {
    const row = await prisma.staffLeavePolicy.findUnique({ where: { tenantId } });
    return row ? parseLeavePolicy(row) : { ...DEFAULT_LEAVE_POLICY };
};

/**
 * Darf der Aufrufer die Personalakte DIESER Person sehen bzw. ändern?
 * Die eigene Akte steht jeder Person offen; eine fremde braucht das Recht.
 * Geändert werden die Stammdaten NUR mit Verwaltungsrecht — auch die eigenen
 * (Vorgabe: «Systemrolle, Vor- und Nachname darf nur die Verwaltung ändern»).
 */
const accessFor = async (req: any, employeeId: string) => {
    const user = req.user!;
    const isSelf = employeeId === user.id;
    const permissions = await roleRepo.getEmployeePermissions(user.id);
    const canManage = permissions.includes('employees.update') || permissions.includes('roles.manage');
    const canRead = isSelf || canManage || permissions.includes('employees.view');
    return { isSelf, canRead, canManage, permissions };
};

// ─────────────────────────────────────────────────────────────────────────────
// Urlaubsregel (Einstellungen → Module → Personal)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/leave-policy', requireAuth, async (req, res) => {
    try {
        res.status(200).json({ policy: await loadLeavePolicy(await houseTenantId(req)) });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.put('/leave-policy', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        const policy = parseLeavePolicy(req.body);
        const saved = await prisma.staffLeavePolicy.upsert({
            where: { tenantId },
            create: { id: nanoid(), tenantId, ...policy },
            update: policy,
        });
        res.status(200).json({ policy: parseLeavePolicy(saved) });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Feiertage
// ─────────────────────────────────────────────────────────────────────────────

const holidayDto = (row: {
    id: string; date: Date; name: string; catalogKey: string | null;
    countryCode: string; religious: boolean; halfDay: boolean;
}) => ({
    id: row.id,
    date: toDateKey(new Date(row.date)),
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
router.get('/holidays', requireAuth, async (req, res) => {
    try {
        const year = Math.trunc(Number(req.query.year)) || new Date().getFullYear();
        const country = String(req.query.country || 'TR').toUpperCase().slice(0, 2);
        const tenantId = await houseTenantId(req);

        const rows = await loadHolidays(
            tenantId,
            new Date(year, 0, 1),
            new Date(year, 11, 31, 23, 59, 59, 999),
        );

        res.status(200).json({
            year,
            country,
            holidays: rows.map(holidayDto),
            catalog: holidayCatalog(year, country),
            catalogYears: holidayCatalogYears(),
        });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.post('/holidays', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        const date = parseDateOnly(req.body?.date);
        if (!date) return fail(res, 400, 'Datum ist ungültig.');
        const name = String(req.body?.name ?? '').trim().slice(0, 120);
        if (!name) return fail(res, 400, 'Bitte den Feiertag benennen.');

        /* `upsert` auf (Mandant, Tag, Name): zweimal auf denselben Knopf zu
           drücken darf keinen zweiten Eintrag machen — und keine 500. */
        const saved = await prisma.publicHoliday.upsert({
            where: { tenantId_date_name: { tenantId, date: startOfDay(date), name } },
            create: {
                id: nanoid(),
                tenantId,
                date: startOfDay(date),
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
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/** Mehrere Katalogtage auf einmal übernehmen («alle amtlichen Tage des Jahres»). */
router.post('/holidays/bulk', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
        if (!rows.length) return fail(res, 400, 'Keine Feiertage übergeben.');

        const data = rows
            .map((row: any) => {
                const date = parseDateOnly(row?.date);
                const name = String(row?.name ?? '').trim().slice(0, 120);
                if (!date || !name) return null;
                return {
                    id: nanoid(),
                    tenantId,
                    date: startOfDay(date),
                    name,
                    catalogKey: String(row?.catalogKey ?? '').trim() || null,
                    countryCode: String(row?.countryCode || 'TR').toUpperCase().slice(0, 2),
                    religious: Boolean(row?.religious),
                    halfDay: Boolean(row?.halfDay),
                };
            })
            .filter(Boolean) as any[];
        if (!data.length) return fail(res, 400, 'Keine gültige Zeile dabei.');

        // `skipDuplicates`: was schon geführt wird, bleibt unverändert stehen.
        await prisma.publicHoliday.createMany({ data, skipDuplicates: true });

        const years = [...new Set(data.map((row) => new Date(row.date).getFullYear()))];
        const saved = await prisma.publicHoliday.findMany({
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
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.delete('/holidays/:id', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantId = await houseTenantId(req);
        // `deleteMany`, nicht `delete`: ein zweiter Klick auf denselben
        // Papierkorb soll das Ziel bestätigen, nicht mit P2025 scheitern.
        await prisma.publicHoliday.deleteMany({ where: { id: String(req.params.id), tenantId } });
        res.status(204).end();
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Personalakte: Stammdaten
// ─────────────────────────────────────────────────────────────────────────────

const documentDto = (row: {
    id: string; kind: string; title: string; fileName: string;
    contentType: string; sizeBytes: number; createdAt: Date;
}) => ({
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
router.get('/staff/:id/profile', requireAuth, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const access = await accessFor(req, id);
        if (!access.canRead) return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');

        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0) return fail(res, 404, 'Person nicht gefunden.');

        const [person, documents, roles] = await Promise.all([
            prisma.employee.findFirst({
                where: { id, tenantId: { in: tenantIds }, deletedAt: null },
                select: {
                    id: true, staffNumber: true, firstName: true, lastName: true,
                    email: true, phone: true, title: true, isActive: true,
                    staffRole: true, workLocation: true, hireDate: true, terminationDate: true,
                    createdAt: true, profilePictureUrl: true, roleName: true,
                    employeeRoles: {
                        take: 1,
                        select: { role: { select: { id: true, roleName: true, isSystemAdmin: true } as any } },
                    },
                },
            }),
            prisma.staffDocument.findMany({
                where: { employeeId: id },
                orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
                select: {
                    id: true, kind: true, title: true, fileName: true,
                    contentType: true, sizeBytes: true, createdAt: true,
                },
            }),
            // Die Auswahlliste der Systemrollen — nur die Verwaltung sieht sie.
            access.canManage
                ? prisma.role.findMany({
                    where: { tenantId: { in: tenantIds } },
                    select: { id: true, roleName: true },
                    orderBy: { roleName: 'asc' },
                })
                : Promise.resolve([]),
        ]);

        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        const assigned = (person as any).employeeRoles?.[0]?.role ?? null;
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
    } catch (error: any) {
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
router.patch('/staff/:id/profile', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const tenantIds = await treeOf(req);
        const existing = await prisma.employee.findFirst({
            where: { id, tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true, email: true },
        });
        if (!existing) return fail(res, 404, 'Person nicht gefunden.');

        const data: Record<string, unknown> = {};
        const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

        if (req.body?.firstName !== undefined) {
            const value = text(req.body.firstName, 100);
            if (!value) return fail(res, 400, 'Vorname darf nicht leer sein.');
            data.firstName = value;
        }
        if (req.body?.lastName !== undefined) {
            const value = text(req.body.lastName, 100);
            if (!value) return fail(res, 400, 'Nachname darf nicht leer sein.');
            data.lastName = value;
        }
        if (req.body?.email !== undefined) {
            const value = text(req.body.email, 190).toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return fail(res, 400, 'Arbeits-E-Mail ist ungültig.');
            if (value !== existing.email) {
                // Die Adresse IST die Anmeldung — sie muss hausweit eindeutig bleiben.
                const taken = await prisma.employee.findFirst({ where: { email: value }, select: { id: true } });
                if (taken && taken.id !== id) return fail(res, 400, 'Diese Adresse ist bereits vergeben.');
            }
            data.email = value;
        }
        if (req.body?.phone !== undefined) data.phone = text(req.body.phone, 60) || null;
        if (req.body?.title !== undefined) data.title = text(req.body.title, 120) || null;
        if (req.body?.hireDate !== undefined) {
            const parsed = parseDateOnly(req.body.hireDate);
            data.hireDate = req.body.hireDate ? (parsed ? startOfDay(parsed) : null) : null;
        }
        if (req.body?.staffRole !== undefined) {
            if (!isStaffRole(req.body.staffRole)) return fail(res, 400, 'Personalrolle ist unbekannt.');
            data.staffRole = req.body.staffRole;
        }
        if (req.body?.workLocation !== undefined) {
            if (!isWorkLocation(req.body.workLocation)) return fail(res, 400, 'Arbeitsort ist unbekannt.');
            data.workLocation = req.body.workLocation;
        }

        if (Object.keys(data).length === 0) return fail(res, 400, 'Nichts zu ändern.');

        const saved = await prisma.employee.update({
            where: { id },
            data,
            select: {
                id: true, firstName: true, lastName: true, email: true, phone: true,
                title: true, staffRole: true, workLocation: true, hireDate: true,
            },
        });

        /* Der Personenverzeichnis-Zwischenspeicher hält Name und Adresse; ohne
           dieses Verwerfen zeigten Auswahllisten den alten Namen weiter. */
        invalidateStaffDirectory();
        auditLog.log({
            action: 'personnel.profile.update',
            tenantId: req.user!.tenantId,
            employeeId: req.user!.id,
            entityType: 'Employee',
            entityId: id,
            metadata: { fields: Object.keys(data) },
            ...auditLog.context(req),
        });

        res.status(200).json(saved);
    } catch (error: any) {
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
router.post(
    '/staff/:id/documents',
    requireAuth,
    requireAnyPermission(['employees.update', 'roles.manage']),
    staffDocumentUpload.single('file'),
    async (req, res) => {
        try {
            const id = String(req.params.id || '');
            const tenantIds = await treeOf(req);
            const person = await prisma.employee.findFirst({
                where: { id, tenantId: { in: tenantIds }, deletedAt: null },
                select: { id: true, tenantId: true },
            });
            if (!person) return fail(res, 404, 'Person nicht gefunden.');

            const file = (req as any).file as { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined;
            if (!file) return fail(res, 400, 'Keine Datei empfangen.');
            if (!staffDocumentStorage.accepts(file.mimetype)) {
                return fail(res, 400, 'Diese Dateiart wird nicht angenommen (PDF, Bild, Word, Excel, Text).');
            }

            const kind = String(req.body?.kind || 'DOCUMENT') === 'CONTRACT' ? 'CONTRACT' : 'DOCUMENT';
            const title = String(req.body?.title ?? '').trim().slice(0, 200) || file.originalname;

            const fileRef = await staffDocumentStorage.store(person.tenantId, file.buffer, file.mimetype);

            /* Der Vertrag ist EINER. Erst die Datei schreiben, dann die alte
               Zeile abräumen: geht das Schreiben schief, steht der bisherige
               Vertrag noch da. */
            let replaced: Array<{ fileRef: string }> = [];
            if (kind === 'CONTRACT') {
                replaced = await prisma.staffDocument.findMany({
                    where: { employeeId: id, kind: 'CONTRACT' },
                    select: { fileRef: true },
                });
                await prisma.staffDocument.deleteMany({ where: { employeeId: id, kind: 'CONTRACT' } });
            }

            const saved = await prisma.staffDocument.create({
                data: {
                    id: nanoid(),
                    tenantId: person.tenantId,
                    employeeId: id,
                    kind,
                    title,
                    fileName: file.originalname,
                    contentType: file.mimetype,
                    sizeBytes: file.size,
                    fileRef,
                    uploadedById: req.user!.id,
                },
                select: {
                    id: true, kind: true, title: true, fileName: true,
                    contentType: true, sizeBytes: true, createdAt: true,
                },
            });

            // Die verdrängten Dateien liegen sonst für immer auf der Platte.
            for (const old of replaced) {
                await staffDocumentStorage.remove(old.fileRef).catch(() => { /* verwaist, nicht fatal */ });
            }

            res.status(201).json(documentDto(saved));
        } catch (error: any) {
            fail(res, 400, error.message);
        }
    },
);

/** GET /personnel/documents/:documentId — der Inhalt, erst beim Öffnen. */
router.get('/documents/:documentId', requireAuth, async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const document = await prisma.staffDocument.findFirst({
            where: { id: String(req.params.documentId || ''), tenantId: { in: tenantIds } },
        });
        if (!document) return fail(res, 404, 'Unterlage nicht gefunden.');

        const access = await accessFor(req, document.employeeId);
        if (!access.canRead) return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');

        const body = await staffDocumentStorage.read(document.fileRef);
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
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.delete('/documents/:documentId', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const document = await prisma.staffDocument.findFirst({
            where: { id: String(req.params.documentId || ''), tenantId: { in: tenantIds } },
            select: { id: true, fileRef: true },
        });
        if (!document) return fail(res, 404, 'Unterlage nicht gefunden.');

        await prisma.staffDocument.deleteMany({ where: { id: document.id } });
        await staffDocumentStorage.remove(document.fileRef).catch(() => { /* verwaist, nicht fatal */ });
        res.status(204).end();
    } catch (error: any) {
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
router.get('/staff/:id/leave-year', requireAuth, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const access = await accessFor(req, id);
        if (!access.canRead) return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');

        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user!.tenantId;
        const year = Math.trunc(Number(req.query.year)) || new Date().getFullYear();

        const person = await prisma.employee.findFirst({
            where: { id, tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true, hireDate: true, createdAt: true },
        });
        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        const [plan, policy] = await Promise.all([loadShiftPlan(tenantId), loadLeavePolicy(tenantId)]);

        const leaveYear = await buildLeaveYear({
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
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Arbeitszeitnachweis
// ─────────────────────────────────────────────────────────────────────────────

/** Die Kennzahlen, die eine Person im Zeitraum erreicht hat. */
const summarisePerson = (input: {
    days: Array<{ actualWorkSeconds: number; grossSeconds: number; breakSeconds: number }>;
    absences: Array<{ kind: string }>;
    targetHours: number;
    dailyNetHours: number;
}) => {
    const totals = input.days.reduce(
        (sum, day) => ({
            actual: sum.actual + day.actualWorkSeconds,
            gross: sum.gross + day.grossSeconds,
            breaks: sum.breaks + day.breakSeconds,
        }),
        { actual: 0, gross: 0, breaks: 0 },
    );
    const balance = buildAccountingBalance(totals.actual, {
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
router.get('/staff/:id/time-log', requireAuth, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const access = await accessFor(req, id);
        if (!access.canRead) return fail(res, 403, 'Für fremde Personalakten fehlt die Berechtigung.');

        const start = parseDateOnly(req.query.startDate);
        const end = parseDateOnly(req.query.endDate);
        if (!start || !end || end < start) return fail(res, 400, 'Zeitraum ist ungültig.');

        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user!.tenantId;
        const plan = await loadShiftPlan(tenantId);

        const person = await prisma.employee.findFirst({
            where: { id, tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true, staffNumber: true, firstName: true, lastName: true, email: true, hireDate: true, createdAt: true },
        });
        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        const filters = { start: startOfDay(start), end: endOfDay(end), employeeId: id };
        const [report, holidayRows, flags] = await Promise.all([
            buildDetailedReport(tenantIds, filters, plan),
            loadHolidays(tenantId, filters.start, filters.end),
            loadLeaveFlags([id], filters.start, filters.end),
        ]);

        const holidays = holidayIndex(holidayRows);
        const workedDayKeys = new Set(report.days.map((day) => toDateKey(day.workDate)));
        const absences = buildAbsences({
            start: filters.start,
            end: filters.end,
            plan,
            holidays,
            workedDayKeys,
            flags,
            since: person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt),
            until: new Date(),
        });

        const dailyNetHours = round2(netShiftMinutes(plan) / 60);
        const workdays = workdaysWithoutHolidays(filters.start, filters.end, plan, holidays);
        const targetHours = round2(workdays * dailyNetHours);
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
    } catch (error: any) {
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
router.get('/time-records', requireAuth, requirePermission('attendance.read'), async (req, res) => {
    try {
        const start = parseDateOnly(req.query.startDate);
        const end = parseDateOnly(req.query.endDate);
        if (!start || !end || end < start) return fail(res, 400, 'Zeitraum ist ungültig.');

        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user!.tenantId;
        const plan = await loadShiftPlan(tenantId);

        const employeeIds = String(req.query.employeeIds ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

        const staff = await loadStaffForSearch(tenantIds, {
            search: String(req.query.search ?? ''),
            employeeIds,
        });
        if (staff.length === 0) {
            return res.status(200).json({ plan, basis: null, people: [], days: [], holidays: [] });
        }

        const filters = { start: startOfDay(start), end: endOfDay(end) };
        const staffIds = staff.map((person) => person.id);

        const [holidayRows, flags] = await Promise.all([
            loadHolidays(tenantId, filters.start, filters.end),
            loadLeaveFlags(staffIds, filters.start, filters.end),
        ]);
        const holidays = holidayIndex(holidayRows);

        /* Der Rapport wird EINMAL über die gesuchten Personen gebaut und danach
           je Person aufgeteilt — nicht je Person einmal gerufen. Bei vierzig
           Personen ist das der Unterschied zwischen zwei Netzwegen und achtzig.
           Die Personenliste reicht die Suche gleich mit hinein, damit nicht
           auch noch die Stempelungen aller anderen geladen werden. */
        const report = await buildDetailedReport(tenantIds, filters, plan, staff);
        const days = report.days;

        const daysByPerson = new Map<string, typeof days>();
        for (const day of days) {
            const bucket = daysByPerson.get(day.employeeId);
            if (bucket) bucket.push(day);
            else daysByPerson.set(day.employeeId, [day]);
        }
        const flagsByPerson = new Map<string, typeof flags>();
        for (const flag of flags) {
            const bucket = flagsByPerson.get(flag.employeeId);
            if (bucket) bucket.push(flag);
            else flagsByPerson.set(flag.employeeId, [flag]);
        }

        const dailyNetHours = round2(netShiftMinutes(plan) / 60);
        const workdays = workdaysWithoutHolidays(filters.start, filters.end, plan, holidays);
        const targetHours = round2(workdays * dailyNetHours);
        const now = new Date();

        const people: TimeRecordPerson[] = staff.map((person) => {
            const personDays = daysByPerson.get(person.id) ?? [];
            const workedDayKeys = new Set(personDays.map((day) => toDateKey(day.workDate)));
            const absences = buildAbsences({
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
    } catch (error: any) {
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
router.post('/time-entries/bulk', requireAuth, requireAnyPermission(['attendance.create', 'attendance.update']), async (req, res) => {
    try {
        const employeeId = String(req.body?.employeeId || '');
        const start = parseDateOnly(req.body?.startDate);
        const end = parseDateOnly(req.body?.endDate);
        if (!employeeId) return fail(res, 400, 'Person fehlt.');
        if (!start || !end || end < start) return fail(res, 400, 'Zeitraum ist ungültig.');
        /* KEINE Zeitraumgrenze mehr (Vorgabe 27.08.2026: «beim Nachtragen gibt
           es keine Beschränkung»). Die natürliche Grenze bleibt: unterhalb des
           Eintritts und ab heute entsteht ohnehin keine Zeile. */

        const tenantIds = await treeOf(req);
        const person = await prisma.employee.findFirst({
            where: { id: employeeId, tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true, tenantId: true, hireDate: true, createdAt: true },
        });
        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        const tenantId = await houseTenantId(req);
        const plan = await loadShiftPlan(tenantId);
        const rangeStart = startOfDay(start);
        const rangeEnd = endOfDay(end);

        const [holidayRows, existing] = await Promise.all([
            loadHolidays(tenantId, rangeStart, rangeEnd),
            prisma.staffTimeEntry.findMany({
                where: { employeeId, workDate: { gte: rangeStart, lte: rangeEnd } },
                select: { workDate: true },
            }),
        ]);
        const holidays = holidayIndex(holidayRows);
        const stamped = new Set(existing.map((row) => toDateKey(new Date(row.workDate))));

        const today = startOfDay(new Date());
        const since = startOfDay(person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt));
        const startMinutes = minutesOfDay(plan.startTime);
        const endMinutes = minutesOfDay(plan.endTime);

        const data: any[] = [];
        let skipped = 0;
        for (let day = rangeStart; day.getTime() <= rangeEnd.getTime(); day = addDays(day, 1)) {
            const key = toDateKey(day);
            const eligible = plan.workdays.includes(isoWeekday(day))
                && !holidays.has(key)
                && !stamped.has(key)
                && day.getTime() < today.getTime()
                && day.getTime() >= since.getTime();
            if (!eligible) { skipped += 1; continue; }

            const startedAt = new Date(day.getTime() + startMinutes * 60_000);
            // Nachtschicht (Ende ≤ Beginn): das Ende liegt am Folgetag.
            const endedAt = endMinutes > startMinutes
                ? new Date(day.getTime() + endMinutes * 60_000)
                : new Date(addDays(day, 1).getTime() + endMinutes * 60_000);
            data.push({
                id: nanoid(),
                tenantId: person.tenantId,
                employeeId,
                workDate: day,
                startedAt,
                endedAt,
                durationSeconds: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
                source: 'MANUAL',
                editedById: req.user!.id,
                note: 'Nachtrag',
            });
        }

        if (data.length) await prisma.staffTimeEntry.createMany({ data });

        auditLog.log({
            action: 'personnel.timeEntry.bulkCreate',
            tenantId: req.user!.tenantId,
            employeeId: req.user!.id,
            entityType: 'StaffTimeEntry',
            metadata: { targetEmployeeId: employeeId, created: data.length, from: toDateKey(rangeStart), to: toDateKey(rangeEnd) },
            ...auditLog.context(req),
        });

        res.status(201).json({ created: data.length, skipped });
    } catch (error: any) {
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
router.post('/absences/manual', requireAuth, requireAnyPermission(['attendance.create', 'attendance.update', 'employees.update']), async (req, res) => {
    try {
        const employeeId = String(req.body?.employeeId || '');
        const start = parseDateOnly(req.body?.startDate);
        const end = parseDateOnly(req.body?.endDate);
        if (!employeeId) return fail(res, 400, 'Person fehlt.');
        if (!start || !end || end < start) return fail(res, 400, 'Zeitraum ist ungültig.');
        /* KEINE Zeitraumgrenze (Vorgabe 27.08.2026) — der Eintrag ist ohnehin
           auf Eintritt bis heute eingezäunt.
           HEUTE ist erlaubt (Vorfall 27.08.2026: das Formular belegt das Ende
           mit dem heutigen Tag vor, und der Vergleich auf das TAGESENDE wies
           genau diese Vorbelegung ab). Abgelehnt wird erst ein Ende MORGEN. */
        if (startOfDay(end).getTime() > startOfDay(new Date()).getTime()) {
            return fail(res, 400, 'Nachgetragen wird Vergangenes — das Ende liegt in der Zukunft.');
        }

        const tenantIds = await treeOf(req);
        const person = await prisma.employee.findFirst({
            where: { id: employeeId, tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true, tenantId: true, hireDate: true, createdAt: true },
        });
        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        const since = startOfDay(person.hireDate ? new Date(person.hireDate) : new Date(person.createdAt));
        if (startOfDay(start).getTime() < since.getTime()) {
            return fail(res, 400, `Der Beginn liegt vor dem Eintritt (${toDateKey(since)}).`);
        }

        const label = String(req.body?.label ?? '').trim().slice(0, 120) || 'Abwesenheit (Nachtrag)';
        const plan = await loadShiftPlan(await houseTenantId(req));
        const now = new Date();

        const created = await prisma.staffLeaveRequest.create({
            data: {
                id: nanoid(),
                tenantId: person.tenantId,
                employeeId,
                kind: 'LEAVE',
                leaveType: 'OTHER',
                leaveTypeLabel: label,
                startDate: startOfDay(start),
                endDate: endOfDay(end),
                totalDays: leaveWorkdays(start, end, plan),
                note: 'Nachtrag',
                // Bereits ABGESCHLOSSEN: der Nachtrag dokumentiert, er beantragt
                // nichts — er darf in keinem Postfach auftauchen.
                status: 'APPROVED',
                approverId: req.user!.id,
                managerDecisionAt: now,
                managerNote: 'Nachtrag',
                accountingDecisionAt: now,
                accountingNote: 'Nachtrag',
            },
            select: { id: true, startDate: true, endDate: true, totalDays: true },
        });

        auditLog.log({
            action: 'personnel.absence.manualCreate',
            tenantId: req.user!.tenantId,
            employeeId: req.user!.id,
            entityType: 'StaffLeaveRequest',
            entityId: created.id,
            metadata: { targetEmployeeId: employeeId, from: toDateKey(start), to: toDateKey(end), label },
            ...auditLog.context(req),
        });

        res.status(201).json({ id: created.id, totalDays: created.totalDays });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * GET /personnel/absences?startDate&endDate&search=
 * Der Abwesenheitsfilter der Antragsseite («es muss alles filterbar sein»):
 * dieselbe Rechnung wie oben, aber nur die Fehltage — ohne die Tageszeilen,
 * die sie nicht braucht.
 */
router.get('/absences', requireAuth, requirePermission('attendance.read'), async (req, res) => {
    try {
        const start = parseDateOnly(req.query.startDate);
        const end = parseDateOnly(req.query.endDate);
        if (!start || !end || end < start) return fail(res, 400, 'Zeitraum ist ungültig.');

        const tenantIds = await treeOf(req);
        const tenantId = tenantIds[0] ?? req.user!.tenantId;
        const plan = await loadShiftPlan(tenantId);

        const staff = await loadStaffForSearch(tenantIds, { search: String(req.query.search ?? '') });
        if (staff.length === 0) return res.status(200).json({ rows: [] });

        const filters = { start: startOfDay(start), end: endOfDay(end) };
        const staffIds = staff.map((person) => person.id);
        const [holidayRows, flags, report] = await Promise.all([
            loadHolidays(tenantId, filters.start, filters.end),
            loadLeaveFlags(staffIds, filters.start, filters.end),
            buildDetailedReport(tenantIds, filters, plan, staff),
        ]);
        const holidays = holidayIndex(holidayRows);

        const workedByPerson = new Map<string, Set<string>>();
        for (const day of report.days) {
            const bucket = workedByPerson.get(day.employeeId) ?? new Set<string>();
            bucket.add(toDateKey(day.workDate));
            workedByPerson.set(day.employeeId, bucket);
        }
        const flagsByPerson = new Map<string, typeof flags>();
        for (const flag of flags) {
            const bucket = flagsByPerson.get(flag.employeeId);
            if (bucket) bucket.push(flag);
            else flagsByPerson.set(flag.employeeId, [flag]);
        }

        const now = new Date();
        const rows = staff.flatMap((person) => buildAbsences({
            start: filters.start,
            end: filters.end,
            plan,
            holidays,
            workedDayKeys: workedByPerson.get(person.id) ?? new Set<string>(),
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
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

export default router;
