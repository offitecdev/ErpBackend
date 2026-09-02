/**
 * ── PERSONALMODUL (Neubau 16.08.2026) ────────────────────────────────────────
 *
 * Ein Router für das ganze Modul: Personalliste + Sammelanlage, QR-Stempeluhr,
 * Schichtplan, Detail- und Buchhaltungsbericht sowie der Urlaubs-/Homeoffice-
 * Weg. Die abgelösten Router (`attendance.routes.ts`, `leave.routes.ts`) sind
 * entfallen.
 *
 * TENANT-BEREICH: Personal gehört der AUSGEWÄHLTEN Firma
 * (getPersonnelTenantScope, seit 31.08.2026) — dieselbe Regel wie bei
 * /employees. Wer unter einer Untergesellschaft angelegt wurde, erscheint
 * NUR dort; Schwesterfirmen sehen einander nicht. Das Arbeitszeitmodell
 * (Schichtplan) bleibt baumweit, siehe shiftPlanTenantId.
 *
 * DER QR-SCHLÜSSEL: `Employee.qrToken` ist der einzige Code je Person. Derselbe
 * Code meldet an der Anmeldeseite an (siehe auth.routes.ts, /auth/qr-login) und
 * stempelt am Tablet ein und aus. Ein Stempeln AUS ist zugleich der Beginn einer
 * Pause — deshalb ist jede Zeile in StaffTimeEntry echte Arbeitszeit.
 */
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { getPersonnelTenantScope, getCompanyTreeTenantIds, employeeScopeWhere, employeeScopeSql } from '../controllers/serviceTenantScope';
import { findTenantRootIdCached } from '../../shared/tenantTree';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { assertPasswordPolicy } from '../../application/validation/password';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import { invalidateStaffDirectory } from '../../shared/staffDirectoryCache';
// Meldung + Mail an alle mit der zuständigen Rolle (26.08.2026).
import { queueLeaveRequestNotice } from '../../infrastructure/services/leaveRequestMailService';
import {
    DEFAULT_SHIFT_PLAN,
    LEAVE_STATUSES,
    LEAVE_TYPES,
    LEAVE_TYPE_LABEL_MAX,
    REMOTE_LEAVE_TYPE,
    isRequestType,
    requestTypeToLeave,
    deriveDayActivity,
    requiresLeaveTypeLabel,
    addDays,
    endOfDay,
    isLeaveType,
    isStaffRole,
    isWorkLocation,
    nextStatusAfterManagerApproval,
    normalizeTime,
    parseDateOnly,
    parseShiftPlan,
    scanTagFor,
    startOfDay,
    summariseDay,
    startOfIsoWeek,
    toDateKey,
    type LeaveKind,
    type ShiftPlan,
} from '../../shared/personnel';
import {
    buildAccountingDetail,
    buildAccountingReport,
    buildDetailedReport,
    leaveWorkdays,
    type ReportFilters,
} from '../../application/services/personnelReports';

const router = Router();
const cryptoService = new BcryptCryptoService();
const roleRepo = new RoleRepository();

/** Der QR-Text auf dem Ausdruck. Das Präfix trennt ihn von jedem anderen Code. */
export const QR_PREFIX = 'OFITEC-STAFF:';
const newQrToken = () => `${QR_PREFIX}${nanoid(24)}`;

/** Die Firmen, aus denen PERSONEN gelesen werden: genau die ausgewählte. */
const treeOf = (req: any): Promise<string[]> => getPersonnelTenantScope(req.user!.tenantId);

const fail = (res: any, status: number, message: string) => res.status(status).json({ error: message });

/** Die Zeitraum- und Namensfilter, die jeder Bericht teilt. */
const readReportFilters = (query: Record<string, unknown>): ReportFilters | null => {
    const start = parseDateOnly(query.startDate);
    const end = parseDateOnly(query.endDate);
    if (!start || !end || end < start) return null;
    return {
        start: startOfDay(start),
        end: endOfDay(end),
        firstName: String(query.firstName ?? '').trim() || undefined,
        lastName: String(query.lastName ?? '').trim() || undefined,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// Schichtplan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Der Plan hängt am STAMM des Firmenbaums, nicht an der gerade gewählten Firma:
 * das Arbeitszeitmodell ist eine Regel des HAUSES — sonst rechnete derselbe
 * Bericht je nach Firmenumschalter andere Sollstunden. Personenlisten sind
 * seit dem 31.08.2026 firmeneigen (treeOf), der Schichtplan ausdrücklich nicht.
 */
const shiftPlanTenantId = async (req: any): Promise<string> =>
    (await findTenantRootIdCached(req.user!.tenantId)) ?? req.user!.tenantId;

const loadShiftPlan = async (req: any): Promise<ShiftPlan> => {
    const tenantId = await shiftPlanTenantId(req);
    const row = await prisma.staffShiftPlan.findUnique({ where: { tenantId } });
    if (!row) return { ...DEFAULT_SHIFT_PLAN };
    return parseShiftPlan({
        workdays: row.workdaysJson,
        startTime: row.startTime,
        endTime: row.endTime,
        breakMinutes: row.breakMinutes,
    });
};

router.get('/shift-plan', requireAuth, async (req, res) => {
    try {
        res.status(200).json({ plan: await loadShiftPlan(req) });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.put('/shift-plan', requireAuth, requirePermission('attendance.update'), async (req, res) => {
    try {
        const plan = parseShiftPlan({
            workdays: req.body?.workdays,
            startTime: normalizeTime(req.body?.startTime, DEFAULT_SHIFT_PLAN.startTime),
            endTime: normalizeTime(req.body?.endTime, DEFAULT_SHIFT_PLAN.endTime),
            // Die Oberfläche erfasst Stunden und Minuten getrennt; gespeichert
            // wird die Summe in Minuten.
            breakMinutes: req.body?.breakMinutes != null
                ? req.body.breakMinutes
                : (Number(req.body?.breakHours ?? 0) * 60) + Number(req.body?.breakMinutesPart ?? 0),
        });
        const tenantId = await shiftPlanTenantId(req);
        await prisma.staffShiftPlan.upsert({
            where: { tenantId },
            create: {
                id: nanoid(),
                tenantId,
                workdaysJson: plan.workdays,
                startTime: plan.startTime,
                endTime: plan.endTime,
                breakMinutes: plan.breakMinutes,
            },
            update: {
                workdaysJson: plan.workdays,
                startTime: plan.startTime,
                endTime: plan.endTime,
                breakMinutes: plan.breakMinutes,
            },
        });
        res.status(200).json({ plan });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Personalliste (reine Ansicht) + Sammelanlage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /personnel/staff — 15 Zeilen je Seite (Vorgabe). Die Liste zeigt Name,
 * Anlagedatum und den QR-Schlüssel; BEARBEITET wird hier nichts.
 */
router.get('/staff', requireAuth, requirePermission('employees.view'), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '15'), 10) || 15));
        if (tenantIds.length === 0) {
            return res.status(200).json({ data: [], total: 0, page, pageSize });
        }

        const conditions: Prisma.Sql[] = [
            employeeScopeSql(tenantIds),
            Prisma.sql`e.deletedAt IS NULL`,
        ];
        const search = String(req.query.search || '').trim();
        if (search) {
            const like = `%${search}%`;
            conditions.push(Prisma.sql`(e.firstName LIKE ${like} OR e.lastName LIKE ${like} OR e.email LIKE ${like})`);
        }
        const whereSql = Prisma.join(conditions, ' AND ');

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT e.id, e.staffNumber, e.firstName, e.lastName, e.email, e.createdAt,
                       e.isActive, e.qrToken, e.staffRole, e.workLocation,
                       (
                           SELECT r.roleName
                           FROM EmployeeRole er
                           JOIN Role r ON r.id = er.roleId
                           WHERE er.employeeId = e.id
                           LIMIT 1
                       ) AS roleName
                FROM Employee e
                WHERE ${whereSql}
                ORDER BY e.createdAt DESC
                LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                SELECT COUNT(*) AS total FROM Employee e WHERE ${whereSql}
            `),
        ]);

        res.status(200).json({
            data: rows.map((row) => ({
                id: String(row.id),
                staffNumber: row.staffNumber == null ? null : Number(row.staffNumber),
                firstName: String(row.firstName ?? ''),
                lastName: String(row.lastName ?? ''),
                email: String(row.email ?? ''),
                createdAt: row.createdAt,
                isActive: Boolean(row.isActive),
                qrToken: row.qrToken == null ? null : String(row.qrToken),
                staffRole: String(row.staffRole ?? 'STAFF'),
                workLocation: String(row.workLocation ?? 'OFFICE'),
                /* Die Rolle aus den Einstellungen — sie hat die Personalrolle
                   in der Liste abgelöst (Vorgabe 27.08.2026). */
                roleName: row.roleName == null ? null : String(row.roleName),
            })),
            total: Number(countRows[0]?.total ?? 0),
            page,
            pageSize,
        });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

interface BulkStaffEntry {
    index: number;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    staffRole: string;
    workLocation: string;
}

/**
 * POST /personnel/staff/bulk — die zeilenweise Erfassung der Liste.
 * ALLES ODER NICHTS: die Zeilen werden zuerst vollständig geprüft (auch gegen
 * Dubletten INNERHALB der Sendung) und dann in EINER Transaktion angelegt. Eine
 * halb angelegte Mannschaft wäre schlimmer als eine abgelehnte Sendung.
 */
router.post('/staff/bulk', requireAuth, requirePermission('employees.create'), async (req, res) => {
    try {
        const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
        if (rawRows.length === 0) return fail(res, 400, 'Mindestens eine Zeile wird benötigt.');
        if (rawRows.length > 100) return fail(res, 400, 'Höchstens 100 Zeilen je Sendung.');

        const entries: BulkStaffEntry[] = [];
        const seenEmails = new Set<string>();
        for (let index = 0; index < rawRows.length; index += 1) {
            const row = rawRows[index] ?? {};
            const firstName = String(row.firstName ?? '').trim();
            const lastName = String(row.lastName ?? '').trim();
            const email = String(row.email ?? '').trim().toLowerCase();
            const password = String(row.password ?? '');
            // Vollständig leere Zeilen sind das normale Ende einer Tabelle.
            if (!firstName && !lastName && !email && !password) continue;
            if (!firstName) return res.status(400).json({ error: 'Vorname fehlt.', index });
            if (!lastName) return res.status(400).json({ error: 'Nachname fehlt.', index });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-Mail-Adresse ist ungültig.', index });
            if (seenEmails.has(email)) return res.status(400).json({ error: 'E-Mail-Adresse kommt in der Sendung doppelt vor.', index });
            try {
                assertPasswordPolicy(password);
            } catch (policyError: any) {
                return res.status(400).json({ error: policyError.message, index });
            }
            seenEmails.add(email);
            entries.push({
                index,
                firstName,
                lastName,
                email,
                password,
                staffRole: isStaffRole(row.staffRole) ? String(row.staffRole) : 'STAFF',
                workLocation: isWorkLocation(row.workLocation) ? String(row.workLocation) : 'OFFICE',
            });
        }
        if (entries.length === 0) return fail(res, 400, 'Mindestens eine Zeile wird benötigt.');

        // Belegte Adressen in EINER Anweisung prüfen (gesperrte Konten halten
        // ihre Adresse dauerhaft besetzt).
        const taken = await prisma.employee.findMany({
            where: { email: { in: entries.map((entry) => entry.email) } },
            select: { email: true },
        });
        if (taken.length > 0) {
            const takenSet = new Set(taken.map((row) => row.email.toLowerCase()));
            const clash = entries.find((entry) => takenSet.has(entry.email));
            return res.status(409).json({ error: `E-Mail-Adresse ist bereits vergeben: ${clash?.email}`, index: clash?.index });
        }

        const tenantId = req.user!.tenantId;
        /* Die Personalnummer laeuft BAUMWEIT weiter, auch wenn die Listen es
           nicht mehr tun: sie steht auf Ausdrucken und Rapporten und soll im
           ganzen Haus genau eine Person meinen. Ein reiner Zaehlerstand
           verraet nichts ueber die Schwesterfirmen. */
        const highest = await prisma.employee.aggregate({
            where: { tenantId: { in: await getCompanyTreeTenantIds(tenantId) } },
            _max: { staffNumber: true },
        });
        let nextStaffNumber = (highest._max.staffNumber ?? 0) + 1;

        // bcrypt ist absichtlich teuer; die Hashes laufen deshalb parallel und
        // VOR der Transaktion — sonst hielte eine 20-Zeilen-Sendung die
        // Datenbankverbindung sekundenlang offen.
        const hashes = await Promise.all(entries.map((entry) => cryptoService.hashPassword(entry.password)));

        const created = await prisma.$transaction(
            entries.map((entry, position) => prisma.employee.create({
                data: {
                    id: nanoid(),
                    tenantId,
                    firstName: entry.firstName,
                    lastName: entry.lastName,
                    email: entry.email,
                    passwordHash: hashes[position]!,
                    isActive: true,
                    staffNumber: nextStaffNumber++,
                    qrToken: newQrToken(),
                    staffRole: entry.staffRole,
                    workLocation: entry.workLocation,
                },
                select: {
                    id: true, staffNumber: true, firstName: true, lastName: true,
                    email: true, createdAt: true, isActive: true, qrToken: true,
                    staffRole: true, workLocation: true,
                },
            })),
        );

        invalidateStaffDirectory();
        auditLog.log({
            action: 'personnel.staff.bulkCreate',
            tenantId,
            employeeId: req.user!.id,
            entityType: 'Employee',
            metadata: { count: created.length },
            ...auditLog.context(req),
        });

        res.status(201).json({ created });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * POST /personnel/staff/:id/qr — Schlüssel neu ausgeben. Der alte Ausdruck wird
 * damit sofort ungültig (verlorene Karte).
 */
router.post('/staff/:id/qr', requireAuth, requirePermission('employees.update'), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const existing = await prisma.employee.findFirst({
            where: { id: String(req.params.id), ...employeeScopeWhere(tenantIds), deletedAt: null },
            select: { id: true },
        });
        if (!existing) return fail(res, 404, 'Person nicht gefunden.');

        const qrToken = newQrToken();
        await prisma.employee.update({ where: { id: existing.id }, data: { qrToken } });
        auditLog.log({
            action: 'personnel.staff.qrRotate',
            tenantId: req.user!.tenantId,
            employeeId: req.user!.id,
            entityType: 'Employee',
            entityId: existing.id,
            ...auditLog.context(req),
        });
        res.status(200).json({ qrToken });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * Wer einen Antrag freigeben darf (Stufe 1 des Weges).
 *
 * SEIT DEM 27.08.2026 EINE FRAGE DER ROLLE aus den Einstellungen, nicht mehr
 * der Personalrolle (die Spalte `staffRole` ist aus der Oberfläche entfernt):
 * freigebend ist, wessen Rolle das Antragspostfach auf Stufe «entscheiden»
 * trägt (`leaves.approve` — typischerweise Administrator und Projektleitung).
 * `roles.manage`/`users.manage` bleiben als Altbestand dabei, damit eine vor
 * dem Umbau gebaute Verwaltungsrolle nicht plötzlich aus der Auswahl fällt.
 *
 * Eine Anweisung mit EXISTS statt findMany+include: die Rechte hängen über
 * EmployeeRole → Role → RolePermission → Permission, und jede Beziehung wäre
 * bei Prisma ein eigener Netzwerkweg.
 */
const APPROVER_PERMISSIONS = ['leaves.approve', 'roles.manage', 'users.manage'];

const approverRowsSql = (tenantIds: string[]) => Prisma.sql`
    SELECT e.id, e.firstName, e.lastName, e.email, e.staffNumber
    FROM Employee e
    WHERE ${employeeScopeSql(tenantIds)}
      AND e.deletedAt IS NULL
      AND e.isActive = 1
      AND EXISTS (
            SELECT 1
            FROM EmployeeRole er
            JOIN RolePermission rp ON rp.roleId = er.roleId
            JOIN Permission p ON p.id = rp.permissionId
            WHERE er.employeeId = e.id
              AND p.permissionName IN (${Prisma.join(APPROVER_PERMISSIONS)})
      )
    ORDER BY e.firstName ASC, e.lastName ASC
`;

/**
 * Führt diese Person die PURSER-Stufe? Der Purser ist die feste Rolle aus den
 * Einstellungen (Role.isPurser) — er hat die Personalrolle ACCOUNTANT abgelöst.
 * Seine Freigabe schliesst einen Urlaubsantrag ab.
 */
const isPurserEmployee = async (employeeId: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT er.employeeId AS id
        FROM EmployeeRole er
        JOIN Role r ON r.id = er.roleId
        WHERE er.employeeId = ${employeeId}
          AND r.isPurser = 1
        LIMIT 1
    `);
    return rows.length > 0;
};

/** Wie viele aktive Personen im Baum die Purser-Rolle tragen. */
const purserCount = async (tenantIds: string[]): Promise<number> => {
    if (tenantIds.length === 0) return 0;
    const rows = await prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT e.id) AS total
        FROM Employee e
        JOIN EmployeeRole er ON er.employeeId = e.id
        JOIN Role r ON r.id = er.roleId
        WHERE ${employeeScopeSql(tenantIds)}
          AND e.deletedAt IS NULL
          AND e.isActive = 1
          AND r.isPurser = 1
    `);
    return Number(rows[0]?.total ?? 0);
};

router.get('/approvers', requireAuth, async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0) return res.status(200).json([]);
        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(approverRowsSql(tenantIds));
        res.status(200).json(rows.map((row) => ({
            id: String(row.id),
            firstName: String(row.firstName ?? ''),
            lastName: String(row.lastName ?? ''),
            email: String(row.email ?? ''),
            staffNumber: row.staffNumber == null ? null : Number(row.staffNumber),
        })));
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/** Prüfung derselben Regel für EINE Person (beim Anlegen eines Antrags). */
const isApprover = async (employeeId: string, tenantIds: string[]): Promise<boolean> => {
    if (!employeeId || tenantIds.length === 0) return false;
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e.id
        FROM Employee e
        WHERE e.id = ${employeeId}
          AND ${employeeScopeSql(tenantIds)}
          AND e.deletedAt IS NULL
          AND e.isActive = 1
          AND EXISTS (
                SELECT 1
                FROM EmployeeRole er
                JOIN RolePermission rp ON rp.roleId = er.roleId
                JOIN Permission p ON p.id = rp.permissionId
                WHERE er.employeeId = e.id
                  AND p.permissionName IN (${Prisma.join(APPROVER_PERMISSIONS)})
          )
        LIMIT 1
    `);
    return rows.length > 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stempeluhr (Tablet)
// ─────────────────────────────────────────────────────────────────────────────

const staffByQrToken = async (token: string, tenantIds: string[]) =>
    prisma.employee.findFirst({
        where: {
            qrToken: token,
            ...employeeScopeWhere(tenantIds),
            deletedAt: null,
            bannedAt: null,
            isActive: true,
        },
        select: { id: true, tenantId: true, firstName: true, lastName: true, staffNumber: true },
    });

/**
 * POST /personnel/clock/scan — ein Scan schaltet um: offenes Fenster? dann
 * schliessen, sonst ein neues öffnen. Die Oberfläche muss nichts wissen.
 *
 * WAS der Scan heisst, entscheidet `scanTagFor` am Schichtplan: der erste Scan
 * des Tages ist IN, jeder weitere vor dem geplanten Schichtende ist BREAK, und
 * ab dem Schichtende wird daraus OUT (Vorgabe). PAUSEN ZÄHLEN NICHT: sie sind
 * die Lücke zwischen zwei Fenstern und werden nirgends addiert.
 */
router.post('/clock/scan', requireAuth, async (req, res) => {
    try {
        const token = String(req.body?.token ?? '').trim();
        if (!token) return fail(res, 400, 'Kein QR-Code erkannt.');

        const tenantIds = await treeOf(req);
        const person = await staffByQrToken(token, tenantIds);
        if (!person) return fail(res, 404, 'Dieser QR-Code gehört zu keiner aktiven Person.');

        const now = new Date();
        const today = startOfDay(now);
        const plan = await loadShiftPlan(req);

        // Ein Weg für beides: das offene Fenster UND die Frage, ob heute schon
        // gestempelt wurde — daran hängt, ob der Scan „Arbeitsbeginn" oder
        // „Pause" heisst.
        const todaysEntries = await prisma.staffTimeEntry.findMany({
            where: { employeeId: person.id, workDate: today },
            orderBy: { startedAt: 'asc' },
            select: { id: true, startedAt: true, endedAt: true, durationSeconds: true },
        });
        // Ein Fenster kann aus einer Nachtschicht des Vortages noch offen sein;
        // es gehört dann zu jenem Tag, schliesst aber genauso.
        const open = todaysEntries.find((entry) => entry.endedAt === null)
            ?? await prisma.staffTimeEntry.findFirst({
                where: { employeeId: person.id, endedAt: null },
                orderBy: { startedAt: 'desc' },
                select: { id: true, startedAt: true, endedAt: true, durationSeconds: true },
            });

        const action = scanTagFor(plan, {
            hasOpenEntry: Boolean(open),
            hasEntriesToday: todaysEntries.length > 0,
            nowMinutes: now.getHours() * 60 + now.getMinutes(),
        });

        if (open) {
            const durationSeconds = Math.max(0, Math.round((now.getTime() - open.startedAt.getTime()) / 1000));
            await prisma.staffTimeEntry.update({
                where: { id: open.id },
                data: { endedAt: now, durationSeconds },
            });
        } else {
            await prisma.staffTimeEntry.create({
                data: {
                    id: nanoid(),
                    tenantId: person.tenantId,
                    employeeId: person.id,
                    workDate: today,
                    startedAt: now,
                    source: 'QR',
                },
            });
        }

        /* Die Tagessumme für die Begrüssung. Sie wird HIER gerechnet statt mit
           einer zweiten Abfrage: die Zeilen von heute liegen schon vor, und das
           soeben geschlossene Fenster ist in ihnen noch offen — sein Anteil
           kommt deshalb dazu. Pausen sind die Lücken dazwischen und fehlen in
           dieser Summe genau deshalb. */
        const closedSeconds = todaysEntries.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0);
        const justClosed = open && open.endedAt === null && todaysEntries.some((entry) => entry.id === open.id)
            ? Math.max(0, Math.round((now.getTime() - open.startedAt.getTime()) / 1000))
            : 0;

        res.status(200).json({
            action,
            at: now,
            employee: {
                id: person.id,
                firstName: person.firstName,
                lastName: person.lastName,
                staffNumber: person.staffNumber,
            },
            todaySeconds: closedSeconds + justClosed,
        });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * GET /personnel/clock/activity — die Ereignisse EINES Tages (Standard: heute),
 * neueste zuerst. Das ist der Inhalt der Tagesübersicht am Tablet.
 *
 * Gespeichert werden Fenster, nicht Ereignisse — die Kennzeichen entstehen
 * deshalb abgeleitet (`deriveDayActivity`), nach derselben Regel, mit der der
 * Scan im Augenblick begrüsst wurde. So steht am Abend in der Liste dasselbe,
 * was mittags auf dem Bildschirm stand, und ein Neuladen des Tablets verliert
 * die Tagesgeschichte nicht.
 */
router.get('/clock/activity', requireAuth, async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0) return res.status(200).json({ date: null, events: [] });

        const day = startOfDay(parseDateOnly(req.query.date) ?? new Date());
        const plan = await loadShiftPlan(req);

        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
            SELECT t.employeeId, t.startedAt, t.endedAt, t.durationSeconds,
                   e.firstName, e.lastName, e.staffNumber
            FROM StaffTimeEntry t
            JOIN Employee e ON e.id = t.employeeId
            WHERE ${employeeScopeSql(tenantIds)}
              AND t.workDate = ${day}
            ORDER BY t.startedAt ASC
        `);

        // Je Person die eigenen Fenster — die Kennzeichen hängen an der Abfolge
        // EINER Person, nicht an der gemeinsamen Zeitachse.
        const byEmployee = new Map<string, Array<Record<string, any>>>();
        for (const row of rows) {
            const key = String(row.employeeId);
            const bucket = byEmployee.get(key);
            if (bucket) bucket.push(row);
            else byEmployee.set(key, [row]);
        }

        const events: Array<Record<string, unknown>> = [];
        for (const [employeeId, spans] of byEmployee) {
            const head = spans[0]!;
            const derived = deriveDayActivity(spans.map((row) => ({
                startedAt: new Date(row.startedAt),
                endedAt: row.endedAt ? new Date(row.endedAt) : null,
                durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
            })), plan);
            const summary = summariseDay(spans.map((row) => ({
                startedAt: new Date(row.startedAt),
                endedAt: row.endedAt ? new Date(row.endedAt) : null,
                durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
            })));
            for (const event of derived) {
                events.push({
                    at: event.at,
                    tag: event.tag,
                    employeeId,
                    firstName: String(head.firstName ?? ''),
                    lastName: String(head.lastName ?? ''),
                    staffNumber: head.staffNumber == null ? null : Number(head.staffNumber),
                    // Tagesstand zum Mitlesen: Arbeitszeit und Pause bis jetzt.
                    actualWorkSeconds: summary.actualWorkSeconds,
                    breakSeconds: summary.breakSeconds,
                });
            }
        }

        events.sort((a, b) => new Date(b.at as Date).getTime() - new Date(a.at as Date).getTime());
        res.status(200).json({ date: toDateKey(day), events: events.slice(0, 60) });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * GET /personnel/clock/week — der Inhalt des „Diese Woche"-Fensters: Montag bis
 * Freitag der laufenden (oder per `weekStart` gewählten) Woche, je Tag die
 * Stempelungen aller Personen des Baums.
 */
router.get('/clock/week', requireAuth, async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0) return res.status(200).json({ weekStart: null, days: [] });

        const anchor = parseDateOnly(req.query.weekStart) ?? new Date();
        const monday = startOfIsoWeek(anchor);
        const friday = endOfDay(addDays(monday, 4));

        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
            SELECT t.id, t.employeeId, t.workDate, t.startedAt, t.endedAt, t.durationSeconds, t.source,
                   e.firstName, e.lastName, e.staffNumber
            FROM StaffTimeEntry t
            JOIN Employee e ON e.id = t.employeeId
            WHERE ${employeeScopeSql(tenantIds)}
              AND t.workDate >= ${monday}
              AND t.workDate <= ${friday}
            ORDER BY t.workDate ASC, e.lastName ASC, t.startedAt ASC
        `);

        const days = Array.from({ length: 5 }, (_, offset) => {
            const date = addDays(monday, offset);
            const key = toDateKey(date);
            const entries = rows
                .filter((row) => toDateKey(new Date(row.workDate)) === key)
                .map((row) => ({
                    id: String(row.id),
                    employeeId: String(row.employeeId),
                    firstName: String(row.firstName ?? ''),
                    lastName: String(row.lastName ?? ''),
                    staffNumber: row.staffNumber == null ? null : Number(row.staffNumber),
                    startedAt: row.startedAt,
                    endedAt: row.endedAt,
                    durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
                    source: String(row.source ?? 'QR'),
                }));
            return {
                date: key,
                isoWeekday: offset + 1,
                entries,
                totalSeconds: entries.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0),
                presentCount: new Set(entries.map((entry) => entry.employeeId)).size,
            };
        });

        res.status(200).json({ weekStart: toDateKey(monday), days });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Berichte
// ─────────────────────────────────────────────────────────────────────────────

router.get('/reports/detailed', requireAuth, requirePermission('attendance.read'), async (req, res) => {
    try {
        const filters = readReportFilters(req.query as Record<string, unknown>);
        if (!filters) return fail(res, 400, 'Zeitraum ist ungültig.');
        const plan = await loadShiftPlan(req);
        const tenantIds = await treeOf(req);
        const report = await buildDetailedReport(tenantIds, filters, plan);
        res.status(200).json(report);
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.get('/reports/accounting', requireAuth, requirePermission('attendance.read'), async (req, res) => {
    try {
        const filters = readReportFilters(req.query as Record<string, unknown>);
        if (!filters) return fail(res, 400, 'Zeitraum ist ungültig.');
        const holidays = Math.max(0, parseInt(String(req.query.publicHolidays ?? '0'), 10) || 0);
        const plan = await loadShiftPlan(req);
        const tenantIds = await treeOf(req);
        res.status(200).json(await buildAccountingReport(tenantIds, filters, plan, holidays));
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.get('/reports/accounting/:employeeId', requireAuth, requirePermission('attendance.read'), async (req, res) => {
    try {
        const filters = readReportFilters(req.query as Record<string, unknown>);
        if (!filters) return fail(res, 400, 'Zeitraum ist ungültig.');
        const holidays = Math.max(0, parseInt(String(req.query.publicHolidays ?? '0'), 10) || 0);
        const plan = await loadShiftPlan(req);
        const tenantIds = await treeOf(req);
        const detail = await buildAccountingDetail(tenantIds, String(req.params.employeeId), filters, plan, holidays);
        if (!detail.person) return fail(res, 404, 'Person nicht gefunden.');
        res.status(200).json({ ...detail, plan });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/** Zeile des Detailberichts korrigieren (Beginn/Ende). */
router.patch('/time-entries/:id', requireAuth, requirePermission('attendance.update'), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const entry = await prisma.staffTimeEntry.findFirst({
            where: { id: String(req.params.id), employee: employeeScopeWhere(tenantIds) },
        });
        if (!entry) return fail(res, 404, 'Zeile nicht gefunden.');

        const startedAt = req.body?.startedAt ? new Date(req.body.startedAt) : entry.startedAt;
        const rawEnd = req.body?.endedAt;
        const endedAt = rawEnd === null ? null : rawEnd ? new Date(rawEnd) : entry.endedAt;
        if (Number.isNaN(startedAt.getTime())) return fail(res, 400, 'Beginn ist ungültig.');
        if (endedAt && Number.isNaN(endedAt.getTime())) return fail(res, 400, 'Ende ist ungültig.');
        if (endedAt && endedAt < startedAt) return fail(res, 400, 'Das Ende liegt vor dem Beginn.');

        const updated = await prisma.staffTimeEntry.update({
            where: { id: entry.id },
            data: {
                startedAt,
                endedAt,
                durationSeconds: endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null,
                workDate: startOfDay(startedAt),
                source: 'MANUAL',
                editedById: req.user!.id,
                note: req.body?.note === undefined ? entry.note : (String(req.body.note ?? '').trim() || null),
            },
        });

        auditLog.log({
            action: 'personnel.timeEntry.update',
            tenantId: req.user!.tenantId,
            employeeId: req.user!.id,
            entityType: 'StaffTimeEntry',
            entityId: entry.id,
            ...auditLog.context(req),
        });
        res.status(200).json(updated);
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

router.delete('/time-entries/:id', requireAuth, requirePermission('attendance.update'), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const entry = await prisma.staffTimeEntry.findFirst({
            where: { id: String(req.params.id), employee: employeeScopeWhere(tenantIds) },
            select: { id: true },
        });
        if (!entry) return fail(res, 404, 'Zeile nicht gefunden.');
        await prisma.staffTimeEntry.delete({ where: { id: entry.id } });
        auditLog.log({
            action: 'personnel.timeEntry.delete',
            tenantId: req.user!.tenantId,
            employeeId: req.user!.id,
            entityType: 'StaffTimeEntry',
            entityId: entry.id,
            ...auditLog.context(req),
        });
        res.status(204).end();
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Urlaubs- und Homeoffice-Anträge
// ─────────────────────────────────────────────────────────────────────────────

const LEAVE_SELECT = {
    id: true, kind: true, leaveType: true, leaveTypeLabel: true, startDate: true, endDate: true, totalDays: true,
    note: true, status: true, approverId: true, managerDecisionAt: true, managerNote: true,
    accountantId: true, accountingDecisionAt: true, accountingNote: true, createdAt: true,
    employee: { select: { id: true, firstName: true, lastName: true, staffNumber: true, email: true } },
    approver: { select: { id: true, firstName: true, lastName: true } },
    accountant: { select: { id: true, firstName: true, lastName: true } },
} as const;

/**
 * Die vier Antragsarten der Oberfläche als Bedingung auf die Zeile.
 * Sie sind eine SICHT auf `kind` + `leaveType` (siehe shared/personnel.ts) —
 * es gibt keine eigene Spalte, die widersprechen könnte.
 */
const requestTypeCondition = (requestType: string): Prisma.StaffLeaveRequestWhereInput | null => {
    switch (requestType) {
        case 'VACATION': return { kind: 'LEAVE', leaveType: 'ANNUAL_PAID' };
        case 'REMOTE': return { kind: 'REMOTE' };
        case 'SICK': return { kind: 'LEAVE', leaveType: { in: ['SICK_SHORT', 'SICK_LONG'] } };
        case 'OTHER': return { kind: 'LEAVE', leaveType: { in: ['OTHER', 'EXCUSE'] } };
        default: return null;
    }
};

/**
 * GET /personnel/leaves?scope=mine|incoming|approver|accounting|all
 *
 *   mine        eigene Anträge
 *   incoming    ALLES, was auf MICH wartet oder von mir entschieden wurde —
 *               die Freigabestufe UND die Buchhaltungsstufe in einer Liste.
 *               Sie ist der Reiter «Eingehende Anträge» der einen Antragsseite
 *               (Vorgabe 26.08.2026: nicht drei Menüpunkte, sondern einer mit
 *               Reitern). `approver` und `accounting` bleiben als die beiden
 *               Hälften bestehen — Altlinks und der Zähler brauchen sie.
 *   approver    nur die Freigabestufe
 *   accounting  nur die Buchhaltungsstufe: NUR was der Vorgesetzte durch-
 *               gelassen hat — vorher erfährt die Buchhaltung nichts.
 *   all         Übersicht für die Personalverwaltung (leaves.read)
 *
 * Zusätzliche Filter, die für JEDEN Bereich gelten (Vorgabe: «es muss alles
 * filterbar sein»): `requestType` (Urlaub/Homeoffice/Krankheit/Sonstiges),
 * `status`, `from`/`to` und die Freitextsuche `search` über den Namen.
 */
router.get('/leaves', requireAuth, async (req, res) => {
    try {
        const scope = String(req.query.scope || 'mine');
        const tenantIds = await treeOf(req);
        const kind = String(req.query.kind || '').trim();

        const where: Prisma.StaffLeaveRequestWhereInput = {
            employee: employeeScopeWhere(tenantIds.length ? tenantIds : [req.user!.tenantId]),
        };
        if (kind === 'LEAVE' || kind === 'REMOTE') where.kind = kind;

        /* ── Filter, die für JEDEN Bereich gelten ────────────────────────────
           Sie hängen bewusst in einem eigenen `AND` und nicht direkt am
           `where`: der Bereich setzt teils dieselben Felder (die Buchhaltung
           schränkt `status` selbst ein), und ein direkt gesetztes Feld würde
           das eine oder das andere still überschreiben. Zwei getrennte
           Bedingungen, die BEIDE gelten müssen, kann sich nicht widersprechen. */
        const extra: Prisma.StaffLeaveRequestWhereInput[] = [];

        const typeCondition = requestTypeCondition(String(req.query.requestType || '').trim());
        if (typeCondition) extra.push(typeCondition);

        const status = String(req.query.status || '').trim();
        if ((LEAVE_STATUSES as readonly string[]).includes(status)) extra.push({ status });

        // Ein Antrag zählt zum Zeitraum, wenn er ihn BERÜHRT — nicht nur, wenn
        // er ganz darin liegt. Ein Urlaub über den Monatswechsel gehört in
        // beide Monatslisten.
        const from = parseDateOnly(req.query.from);
        if (from) extra.push({ endDate: { gte: startOfDay(from) } });
        const to = parseDateOnly(req.query.to);
        if (to) extra.push({ startDate: { lte: endOfDay(to) } });

        const search = String(req.query.search || '').trim();
        if (search) {
            extra.push({
                employee: {
                    OR: [
                        { firstName: { contains: search } },
                        { lastName: { contains: search } },
                        { email: { contains: search } },
                    ],
                },
            });
        }

        if (scope === 'mine') {
            where.employeeId = req.user!.id;
        } else if (scope === 'incoming') {
            /* Beide Stufen in EINER Liste. Die Purser-Hälfte kommt nur dazu,
               wenn der Aufrufer die Rolle auch trägt — sonst verriete der
               Reiter jeder Person den Rückstand der zweiten Stufe. */
            const branches: Prisma.StaffLeaveRequestWhereInput[] = [{ approverId: req.user!.id }];
            if (await isPurserEmployee(req.user!.id)) {
                branches.push({
                    kind: 'LEAVE',
                    status: { in: ['PENDING_ACCOUNTING', 'APPROVED', 'REJECTED'] },
                    managerDecisionAt: { not: null },
                });
            }
            where.OR = branches;
        } else if (scope === 'approver') {
            // Das Postfach der freigebenden Person zeigt NUR, was an sie
            // gerichtet ist — die Zuständigkeit ist die Berechtigung.
            where.approverId = req.user!.id;
        } else if (scope === 'accounting') {
            // Die zweite Stufe steht nur dem PURSER offen, und sie beginnt
            // ERST nach der Freigabe des Vorgesetzten: vorher erfährt er von
            // einem Antrag nichts. Homeoffice läuft gar nicht über ihn.
            if (!(await isPurserEmployee(req.user!.id))) return fail(res, 403, 'Diese Ansicht führt der Purser.');
            where.kind = 'LEAVE';
            where.status = { in: ['PENDING_ACCOUNTING', 'APPROVED', 'REJECTED'] };
            where.managerDecisionAt = { not: null };
        } else if (scope === 'all') {
            // Gesamtübersicht = Personalverwaltung; ohne 'leaves.read' bleibt
            // es bei den eigenen Anträgen.
            const permissions = await roleRepo.getEmployeePermissions(req.user!.id);
            if (!permissions.includes('leaves.read')) return fail(res, 403, 'Für die Gesamtübersicht fehlt die Berechtigung.');
        } else {
            where.employeeId = req.user!.id;
        }

        if (extra.length) where.AND = extra;

        const rows = await prisma.staffLeaveRequest.findMany({
            where,
            select: LEAVE_SELECT,
            orderBy: { createdAt: 'desc' },
            take: 300,
        });
        res.status(200).json(rows);
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * POST /personnel/leaves — einen Antrag stellen.
 *
 * Die Oberfläche schickt seit dem 26.08.2026 die ANTRAGSART (`requestType`:
 * VACATION | REMOTE | SICK | OTHER); daraus werden `kind` und `leaveType`
 * abgeleitet. Der alte Weg (`kind` + `leaveType` direkt) bleibt gültig —
 * die Stempeluhr-Tablets und Altskripte sprechen ihn noch.
 */
router.post('/leaves', requireAuth, async (req, res) => {
    try {
        const requestType = String(req.body?.requestType ?? '').trim();
        const derived = isRequestType(requestType)
            ? requestTypeToLeave(requestType, req.body?.leaveType)
            : null;

        const kind: LeaveKind = derived
            ? derived.kind
            : (String(req.body?.kind) === 'REMOTE' ? 'REMOTE' : 'LEAVE');
        const leaveType = derived
            ? derived.leaveType
            : (kind === 'REMOTE' ? REMOTE_LEAVE_TYPE : String(req.body?.leaveType ?? ''));
        if (kind === 'LEAVE' && !isLeaveType(leaveType)) {
            return fail(res, 400, `Urlaubsart muss eine von ${LEAVE_TYPES.join(', ')} sein.`);
        }

        /* „Sonstiger Urlaub" trägt die Art im FREITEXT — ohne ihn stünde im
           Rapport der Buchhaltung nur „Sonstiger Urlaub" und niemand wüsste,
           worum es geht. Bei den festen Arten wird ein mitgeschickter Text
           verworfen, damit die Beschriftung dort eindeutig bleibt. */
        let leaveTypeLabel: string | null = null;
        if (kind === 'LEAVE' && requiresLeaveTypeLabel(leaveType)) {
            leaveTypeLabel = String(req.body?.leaveTypeLabel ?? '').trim().slice(0, LEAVE_TYPE_LABEL_MAX);
            if (!leaveTypeLabel) return fail(res, 400, 'Bitte die Urlaubsart als Text angeben.');
        }

        const start = parseDateOnly(req.body?.startDate);
        const end = parseDateOnly(req.body?.endDate);
        if (!start || !end || end < start) return fail(res, 400, 'Zeitraum ist ungültig.');

        const tenantIds = await treeOf(req);
        const approverId = String(req.body?.approverId ?? '');
        // Dieselbe Regel wie die Auswahlliste (siehe `isApprover`).
        if (!(await isApprover(approverId, tenantIds))) {
            return fail(res, 400, 'Bitte eine freigebende Person mit Administrationsrecht wählen.');
        }
        if (approverId === req.user!.id) return fail(res, 400, 'Ein Antrag kann nicht bei der eigenen Person eingereicht werden.');

        const plan = await loadShiftPlan(req);
        const created = await prisma.staffLeaveRequest.create({
            data: {
                id: nanoid(),
                tenantId: req.user!.tenantId,
                employeeId: req.user!.id,
                kind,
                leaveType,
                leaveTypeLabel,
                startDate: startOfDay(start),
                endDate: endOfDay(end),
                totalDays: leaveWorkdays(start, end, plan),
                note: String(req.body?.note ?? '').trim() || null,
                status: 'PENDING_MANAGER',
                approverId,
            },
            select: LEAVE_SELECT,
        });

        /* MELDUNG UND MAIL an ALLE mit der Verwaltungsrolle (Vorgabe
           26.08.2026). Feuern und vergessen: ein stummer Mailserver darf das
           Einreichen nicht scheitern lassen — die Meldung im Programm steht
           auch dann, weil sie zuerst geschrieben wird. */
        queueLeaveRequestNotice(created.id, 'MANAGER');

        res.status(201).json(created);
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * PATCH /personnel/leaves/:id/decision — eine Stufe des Weges.
 * Wer entscheidet, ergibt sich aus dem STAND des Antrags, nicht aus einer
 * Angabe des Aufrufers: steht er auf PENDING_MANAGER, darf nur die eingetragene
 * freigebende Person handeln; steht er auf PENDING_ACCOUNTING, nur jemand mit
 * Personalrolle ACCOUNTANT. So kann die Buchhaltung nichts freigeben, das der
 * Vorgesetzte noch gar nicht gesehen hat.
 */
router.patch('/leaves/:id/decision', requireAuth, async (req, res) => {
    try {
        const approve = req.body?.decision === 'APPROVE';
        const reject = req.body?.decision === 'REJECT';
        if (!approve && !reject) return fail(res, 400, 'Entscheidung muss APPROVE oder REJECT sein.');
        const note = String(req.body?.note ?? '').trim() || null;

        const tenantIds = await treeOf(req);
        const request = await prisma.staffLeaveRequest.findFirst({
            where: { id: String(req.params.id), employee: employeeScopeWhere(tenantIds) },
        });
        if (!request) return fail(res, 404, 'Antrag nicht gefunden.');

        const now = new Date();
        if (request.status === 'PENDING_MANAGER') {
            if (request.approverId !== req.user!.id) {
                return fail(res, 403, 'Nur die im Antrag gewählte freigebende Person darf hier entscheiden.');
            }

            /* Wohin der Antrag nach dem Ja geht. Urlaub gehört zum PURSER —
               ABER nur, wenn jemand die Rolle trägt. Führt die Firma (noch)
               niemanden als Purser, bliebe der Antrag sonst für immer in einem
               Postfach liegen, das keiner öffnen kann. Dann schliesst die
               Freigabe ihn ab, und der Vermerk hält fest, warum keine zweite
               Stufe lief. */
            let nextStatus = reject ? 'REJECTED' : nextStatusAfterManagerApproval(request.kind as LeaveKind);
            let accountingNote: string | null = null;
            if (nextStatus === 'PENDING_ACCOUNTING') {
                const accountants = await purserCount(tenantIds);
                if (accountants === 0) {
                    nextStatus = 'APPROVED';
                    accountingNote = 'Kein Purser hinterlegt — mit der Freigabe abgeschlossen.';
                }
            }

            const updated = await prisma.staffLeaveRequest.update({
                where: { id: request.id },
                data: {
                    status: nextStatus,
                    managerDecisionAt: now,
                    managerNote: note,
                    rejectedById: reject ? req.user!.id : null,
                    ...(accountingNote ? { accountingNote, accountingDecisionAt: now } : {}),
                },
                select: LEAVE_SELECT,
            });

            /* «Ich gebe diesen Urlaub frei» → «an die Buchhaltung senden»:
               genau hier erfährt die Buchhaltung zum ersten Mal von dem
               Antrag. Ist er dagegen fertig (Homeoffice, abgelehnt, oder es
               gibt keine Buchhaltung), geht die Nachricht an die
               antragstellende Person. */
            queueLeaveRequestNotice(
                updated.id,
                nextStatus === 'PENDING_ACCOUNTING' ? 'ACCOUNTING' : 'DECIDED',
            );
            return res.status(200).json(updated);
        }

        if (request.status === 'PENDING_ACCOUNTING') {
            if (!(await isPurserEmployee(req.user!.id))) {
                return fail(res, 403, 'Diese Stufe entscheidet der Purser.');
            }
            const updated = await prisma.staffLeaveRequest.update({
                where: { id: request.id },
                data: {
                    status: reject ? 'REJECTED' : 'APPROVED',
                    accountantId: req.user!.id,
                    accountingDecisionAt: now,
                    accountingNote: note,
                    rejectedById: reject ? req.user!.id : null,
                },
                select: LEAVE_SELECT,
            });
            // Endstand — die antragstellende Person erfährt es.
            queueLeaveRequestNotice(updated.id, 'DECIDED');
            return res.status(200).json(updated);
        }

        return fail(res, 400, 'Dieser Antrag ist bereits abgeschlossen.');
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * Offene Anzahl je Stufe — die Zähler auf den Reitern UND der farbige Punkt
 * am Anträge-Zeichen im Kopf (Vorgabe 26.08.2026).
 *
 * `incoming` ist die Summe dessen, was auf MICH wartet: die Freigaben plus —
 * wenn ich die Rolle trage — die Buchhaltungsstufe. Genau diese Zahl färbt den
 * Punkt. Der Buchhaltungszähler steht NUR der Buchhaltung offen: sonst
 * verriete er jeder Person, wie viele Urlaubsanträge gerade in Prüfung sind.
 *
 * `mine` sind die eigenen Anträge, über die noch niemand entschieden hat —
 * der Reiter «Meine Anträge» trägt sie als Plakette.
 */
router.get('/leaves/counts', requireAuth, async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const scope = { employee: employeeScopeWhere(tenantIds.length ? tenantIds : [req.user!.tenantId]) };
        const amPurser = await isPurserEmployee(req.user!.id);
        if (String(req.query.view || '').trim() === 'incoming') {
            const [approver, accounting] = await Promise.all([
                prisma.staffLeaveRequest.count({ where: { ...scope, approverId: req.user!.id, status: 'PENDING_MANAGER' } }),
                amPurser
                    ? prisma.staffLeaveRequest.count({ where: { ...scope, kind: 'LEAVE', status: 'PENDING_ACCOUNTING' } })
                    : Promise.resolve(0),
            ]);
            return res.status(200).json({ incoming: approver + accounting });
        }
        const [approver, accounting, mine] = await Promise.all([
            prisma.staffLeaveRequest.count({ where: { ...scope, approverId: req.user!.id, status: 'PENDING_MANAGER' } }),
            amPurser
                ? prisma.staffLeaveRequest.count({ where: { ...scope, kind: 'LEAVE', status: 'PENDING_ACCOUNTING' } })
                : Promise.resolve(0),
            prisma.staffLeaveRequest.count({
                where: { ...scope, employeeId: req.user!.id, status: { in: ['PENDING_MANAGER', 'PENDING_ACCOUNTING'] } },
            }),
        ]);
        res.status(200).json({ approver, accounting, mine, incoming: approver + accounting });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * Wer bin ich im Personalmodul: Personalrolle und Arbeitsort. Die Oberfläche
 * blendet danach die Postfächer ein — die Prüfung selbst bleibt serverseitig.
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const me = await prisma.employee.findUnique({
            where: { id: req.user!.id },
            select: { id: true, firstName: true, lastName: true, staffRole: true, workLocation: true, staffNumber: true, qrToken: true },
        });
        if (!me) return fail(res, 404, 'Person nicht gefunden.');
        res.status(200).json(me);
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * PATCH /personnel/staff/:id/role — Personalrolle und Arbeitsort pflegen.
 * Bewusst getrennt von der Liste: die Liste ist reine Ansicht, geändert wird
 * hier (und nur mit Personalverwaltungsrecht).
 */
router.patch('/staff/:id/role', requireAuth, requireAnyPermission(['employees.update', 'roles.manage']), async (req, res) => {
    try {
        const tenantIds = await treeOf(req);
        const existing = await prisma.employee.findFirst({
            where: { id: String(req.params.id), ...employeeScopeWhere(tenantIds), deletedAt: null },
            select: { id: true },
        });
        if (!existing) return fail(res, 404, 'Person nicht gefunden.');

        const data: Prisma.EmployeeUpdateInput = {};
        if (req.body?.staffRole !== undefined) {
            if (!isStaffRole(req.body.staffRole)) return fail(res, 400, 'Unbekannte Personalrolle.');
            data.staffRole = String(req.body.staffRole);
        }
        if (req.body?.workLocation !== undefined) {
            if (!isWorkLocation(req.body.workLocation)) return fail(res, 400, 'Unbekannter Arbeitsort.');
            data.workLocation = String(req.body.workLocation);
        }
        if (Object.keys(data).length === 0) return fail(res, 400, 'Nichts zu ändern.');

        const updated = await prisma.employee.update({
            where: { id: existing.id },
            data,
            select: { id: true, staffRole: true, workLocation: true },
        });
        res.status(200).json(updated);
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * GET /personnel/staff/:id/overview — ALLES, was die Personenseite zeigt, in
 * EINER Antwort: Stammdaten, zugewiesene Rolle, Aufgaben, Termine, Urlaube und
 * der offene Kennwortwunsch.
 *
 * Bewusst ein Sammelaufruf statt fünf: die Datenbank steht in der Ferne, jede
 * Anweisung kostet einen vollen Rundgang — fünf Reiter einzeln zu laden hiesse,
 * beim Umschalten jedes Mal darauf zu warten. Die Abfragen laufen PARALLEL, die
 * Seite zahlt also ungefähr die Zeit der langsamsten.
 *
 * Wer darf: die Person selbst immer; fremde Seiten brauchen `employees.view`.
 */
router.get('/staff/:id/overview', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        const isSelf = id === user.id;
        if (!isSelf) {
            const permissions = await roleRepo.getEmployeePermissions(user.id);
            if (!permissions.includes('employees.view')) {
                return fail(res, 403, 'Für fremde Personalseiten fehlt die Berechtigung employees.view.');
            }
        }

        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0) return fail(res, 404, 'Person nicht gefunden.');

        const person = await prisma.employee.findFirst({
            where: { id, ...employeeScopeWhere(tenantIds), deletedAt: null },
            select: {
                id: true, tenantId: true, staffNumber: true, firstName: true, lastName: true,
                email: true, phone: true, title: true, isActive: true, staffRole: true,
                workLocation: true, hireDate: true, createdAt: true, qrToken: true,
                profilePictureUrl: true, roleName: true,
                employeeRoles: { take: 1, select: { role: { select: { id: true, roleName: true, isSystemAdmin: true } as any } } },
            },
        });
        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        // Der Zeitfenster-Anker der Übersicht: die letzten 90 Tage zurück, ein
        // Jahr voraus. Ohne Grenze zöge die Terminliste die ganze Historie mit.
        const now = new Date();
        const since = addDays(startOfDay(now), -90);
        const until = addDays(startOfDay(now), 365);

        const [tasks, meetings, appointments, leaves, approvals, passwordRequest] = await Promise.all([
            // Aufgaben und Erinnerungen, die dieser Person zugewiesen sind.
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT t.id, t.kind, t.title, t.status, t.dueDate, t.completedAt, t.createdAt,
                       c.companyName AS customerName
                FROM CrmTask t
                LEFT JOIN Customer c ON c.id = t.customerId
                WHERE t.assigneeEmployeeId = ${id}
                   OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = t.id AND ta.employeeId = ${id})
                ORDER BY (t.status = 'OPEN') DESC, t.dueDate IS NULL, t.dueDate ASC, t.createdAt DESC
                LIMIT 100
            `),
            // Besprechungen: wo die Person teilnimmt ODER die sie angelegt hat.
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT m.id, m.kind, m.title, m.startTime, m.endTime, m.notes,
                       m.customerId, c.companyName AS customerName,
                       (m.createdByEmployeeId = ${id}) AS isOwner
                FROM MeetingActivity m
                LEFT JOIN Customer c ON c.id = m.customerId
                WHERE m.startTime >= ${since} AND m.startTime <= ${until}
                  AND (
                      m.createdByEmployeeId = ${id}
                      OR EXISTS (
                          SELECT 1 FROM MeetingActivityParticipant p
                          WHERE p.meetingId = m.id AND p.employeeId = ${id}
                      )
                  )
                ORDER BY m.startTime DESC
                LIMIT 100
            `),
            // Termine (Montagetermine): der Person direkt zugewiesen ODER über
            // die Mehrfachbesetzung (ProjectAppointmentAssignment). Beide Wege
            // existieren nebeneinander — wer nur `assignedTechId` abfragt,
            // verliert jeden Termin eines zweiten Monteurs.
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT a.id, a.startTime, a.endTime, a.status, a.notes,
                       a.projectId, a.salesOrderId, a.customerId,
                       p.projectNumber, p.projectName,
                       c.companyName AS customerName,
                       (a.assignedTechId = ${id}) AS isLead
                FROM Appointment a
                LEFT JOIN Project p ON p.id = a.projectId
                LEFT JOIN Customer c ON c.id = a.customerId
                WHERE a.startTime >= ${since} AND a.startTime <= ${until}
                  AND (
                      a.assignedTechId = ${id}
                      OR EXISTS (
                          SELECT 1 FROM ProjectAppointmentAssignment t
                          WHERE t.appointmentId = a.id AND t.technicianId = ${id}
                      )
                  )
                ORDER BY a.startTime DESC
                LIMIT 100
            `),
            // Eigene Urlaubs-/Homeoffice-Anträge.
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT l.id, l.kind, l.leaveType, l.leaveTypeLabel, l.startDate, l.endDate,
                       l.totalDays, l.note, l.status, l.createdAt,
                       l.managerDecisionAt, l.managerNote,
                       l.accountingDecisionAt, l.accountingNote,
                       ap.firstName AS approverFirstName, ap.lastName AS approverLastName
                FROM StaffLeaveRequest l
                LEFT JOIN Employee ap ON ap.id = l.approverId
                WHERE l.employeeId = ${id}
                ORDER BY l.startDate DESC
                LIMIT 60
            `),
            // Anträge, die auf DIESE Person warten (sie ist Freigeberin bzw.
            // führt die Buchhaltungsstufe) — der zweite Teil des Reiters.
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT l.id, l.kind, l.leaveType, l.leaveTypeLabel, l.startDate, l.endDate,
                       l.totalDays, l.status, l.createdAt,
                       e.firstName AS employeeFirstName, e.lastName AS employeeLastName,
                       e.staffNumber AS employeeStaffNumber
                FROM StaffLeaveRequest l
                JOIN Employee e ON e.id = l.employeeId
                WHERE (l.approverId = ${id} AND l.status = 'PENDING_MANAGER')
                   OR (l.accountantId = ${id} AND l.status = 'PENDING_ACCOUNTING')
                ORDER BY l.createdAt DESC
                LIMIT 60
            `),
            (prisma as any).passwordChangeRequest.findFirst({
                where: { employeeId: id, status: 'PENDING' },
                select: { id: true, createdAt: true, note: true },
            }),
        ]);

        const assignedRole = (person.employeeRoles[0]?.role ?? null) as any;
        const nameOf = (first: unknown, last: unknown) =>
            `${String(first ?? '')} ${String(last ?? '')}`.trim() || null;

        res.status(200).json({
            person: {
                id: person.id,
                staffNumber: person.staffNumber == null ? null : Number(person.staffNumber),
                firstName: person.firstName,
                lastName: person.lastName,
                email: person.email,
                phone: person.phone ?? null,
                title: person.title ?? null,
                isActive: person.isActive,
                staffRole: person.staffRole,
                workLocation: person.workLocation,
                hireDate: person.hireDate ?? null,
                createdAt: person.createdAt,
                qrToken: person.qrToken ?? null,
                profilePictureUrl: person.profilePictureUrl ?? null,
                roleId: assignedRole?.id ?? null,
                roleName: assignedRole?.roleName ?? person.roleName ?? null,
                isSystemAdminRole: Boolean(assignedRole?.isSystemAdmin),
            },
            tasks: tasks.map((row) => ({
                id: String(row.id),
                kind: String(row.kind ?? 'TASK'),
                title: String(row.title ?? ''),
                status: String(row.status ?? 'OPEN'),
                dueDate: row.dueDate ?? null,
                completedAt: row.completedAt ?? null,
                createdAt: row.createdAt,
                customerName: row.customerName ?? null,
            })),
            meetings: meetings.map((row) => ({
                id: String(row.id),
                kind: String(row.kind ?? 'MEETING'),
                title: String(row.title ?? ''),
                startTime: row.startTime,
                endTime: row.endTime,
                notes: row.notes ?? null,
                customerId: row.customerId ?? null,
                customerName: row.customerName ?? null,
                isOwner: Boolean(Number(row.isOwner ?? 0)),
            })),
            appointments: appointments.map((row) => ({
                id: String(row.id),
                startTime: row.startTime,
                endTime: row.endTime,
                status: String(row.status ?? 'BOOKED'),
                notes: row.notes ?? null,
                projectId: row.projectId ?? null,
                projectNumber: row.projectNumber ?? null,
                projectName: row.projectName ?? null,
                salesOrderId: row.salesOrderId ?? null,
                customerId: row.customerId ?? null,
                customerName: row.customerName ?? null,
                /** true = die Person führt den Termin (assignedTechId), sonst mitbesetzt. */
                isLead: Boolean(Number(row.isLead ?? 0)),
            })),
            leaves: leaves.map((row) => ({
                id: String(row.id),
                kind: String(row.kind ?? 'LEAVE'),
                leaveType: String(row.leaveType ?? 'OTHER'),
                leaveTypeLabel: row.leaveTypeLabel ?? null,
                startDate: row.startDate,
                endDate: row.endDate,
                totalDays: Number(row.totalDays ?? 0),
                note: row.note ?? null,
                status: String(row.status ?? 'PENDING_MANAGER'),
                createdAt: row.createdAt,
                managerDecisionAt: row.managerDecisionAt ?? null,
                managerNote: row.managerNote ?? null,
                accountingDecisionAt: row.accountingDecisionAt ?? null,
                accountingNote: row.accountingNote ?? null,
                approverName: nameOf(row.approverFirstName, row.approverLastName),
            })),
            approvals: approvals.map((row) => ({
                id: String(row.id),
                kind: String(row.kind ?? 'LEAVE'),
                leaveType: String(row.leaveType ?? 'OTHER'),
                leaveTypeLabel: row.leaveTypeLabel ?? null,
                startDate: row.startDate,
                endDate: row.endDate,
                totalDays: Number(row.totalDays ?? 0),
                status: String(row.status ?? 'PENDING_MANAGER'),
                createdAt: row.createdAt,
                employeeName: nameOf(row.employeeFirstName, row.employeeLastName),
                employeeStaffNumber: row.employeeStaffNumber == null ? null : Number(row.employeeStaffNumber),
            })),
            pendingPasswordRequest: passwordRequest
                ? { id: passwordRequest.id, createdAt: passwordRequest.createdAt, note: passwordRequest.note ?? null }
                : null,
        });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * PUT /personnel/staff/:id/photo — das Profilbild setzen oder entfernen.
 *
 * Das Bild kommt als Daten-URL an (der Browser hat es vorher auf ein Quadrat
 * verkleinert) und wird als solche gespeichert — dieselbe Bauart wie bei den
 * Rapportbildern. Ein Objektspeicher ist dafür nicht nötig und wäre auf
 * Anlagen ohne konfigurierte Ablage sogar ein Ausfall.
 *
 * Wer darf: die Person selbst immer; fremde Bilder braucht `employees.update`.
 */
const PHOTO_MAX_CHARS = 2_000_000; // ≈ 1,5 MB Bild — mehr als ein Kopfbild je braucht.
/**
 * Der Daumennagel ist 128 px gross; alles darüber wäre ein zweites Grossbild.
 *
 * 120_000 statt der früheren 80_000, seit der Browser gezeichnete Avatare
 * verlustfrei als PNG ablegt (19.08.2026): ein Foto-Daumennagel bleibt bei
 * rund 5 KB, ein PNG mit vielen Farbflächen darf aber ein Mehrfaches wiegen —
 * und wurde vorher stumm abgewiesen. Selbst reines Rauschen käme bei 128 px
 * nicht über rund 90 000 Zeichen. Die Grenze ist die NOTBREMSE gegen ein
 * versehentlich durchgereichtes Grossbild, nicht die erwartete Grösse.
 */
const THUMB_MAX_CHARS = 120_000;
const PHOTO_PREFIX = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/** Prüft eine Bild-Daten-URL; gibt die Fehlermeldung zurück oder null. */
const photoProblem = (value: string, limit: number): string | null => {
    if (value.length > limit) return 'Das Bild ist zu gross. Bitte ein kleineres Foto wählen.';
    if (!PHOTO_PREFIX.test(value)) return 'Nur JPEG-, PNG- oder WebP-Bilder sind möglich.';
    return null;
};

router.put('/staff/:id/photo', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        if (id !== user.id) {
            const permissions = await roleRepo.getEmployeePermissions(user.id);
            if (!permissions.includes('employees.update')) {
                return fail(res, 403, 'Für fremde Profilbilder fehlt die Berechtigung employees.update.');
            }
        }

        const body = req.body ?? {};
        const raw = body.photo;
        const photo = raw == null || raw === '' ? null : String(raw);
        if (photo !== null) {
            const problem = photoProblem(photo, PHOTO_MAX_CHARS);
            if (problem) return fail(res, 400, problem);
        }

        // Der Daumennagel gehört ZUM Bild: ohne Bild gibt es auch keinen, und
        // fehlt er beim Setzen (alter Browserstand), tritt das grosse Bild an
        // seine Stelle — lieber schwer als unsichtbar.
        const rawThumb = body.thumb;
        let thumb: string | null = null;
        if (photo !== null) {
            thumb = rawThumb == null || rawThumb === '' ? photo : String(rawThumb);
            const problem = photoProblem(thumb, thumb === photo ? PHOTO_MAX_CHARS : THUMB_MAX_CHARS);
            if (problem) return fail(res, 400, problem);
        }

        const tenantIds = await treeOf(req);
        const person = await prisma.employee.findFirst({
            where: { id, ...employeeScopeWhere(tenantIds), deletedAt: null },
            select: { id: true },
        });
        if (!person) return fail(res, 404, 'Person nicht gefunden.');

        await prisma.employee.update({
            where: { id },
            data: { profilePictureUrl: photo, profilePictureThumb: thumb },
        });
        invalidateStaffDirectory();
        res.status(200).json({ profilePictureUrl: photo, profilePictureThumb: thumb });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

/**
 * GET /personnel/photos?ids=a,b,c — die Daumennägel mehrerer Personen auf einmal.
 *
 * Seit das Profilbild den Namen ERSETZT, braucht es jede Liste, jedes Kopfband
 * und jede Zuteilung. Es an den bestehenden Antworten anzuhängen hiesse, die
 * Bilder bei JEDEM Laden dieser Listen mitzuschleppen — und die Kurzliste
 * (/employees/directory) holt jedes Auswahlfeld neu. Darum ein EIGENER Weg:
 * der Browser fragt nur die Personen, die er gerade zeigt, und merkt sich die
 * Antwort für die ganze Sitzung.
 *
 * NICHT hinter `employees.view`: das Bild ist der Name geworden, und ein Name
 * ist für jede angemeldete Person sichtbar (dieselbe Begründung wie bei
 * /employees/directory). Mehr als das Bild verlässt den Server hier nicht.
 *
 * Fehlt der Daumennagel (Bild von vor dem 18.08.2026), tritt das grosse Bild
 * an seine Stelle — sonst wäre die Person bis zum nächsten Hochladen bildlos.
 */
const PHOTO_LOOKUP_MAX_IDS = 300;

router.get('/photos', requireAuth, async (req, res) => {
    try {
        const ids = String(req.query.ids || '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
            .slice(0, PHOTO_LOOKUP_MAX_IDS);
        if (ids.length === 0) return res.status(200).json({ photos: {} });

        const tenantIds = await treeOf(req);
        if (tenantIds.length === 0) return res.status(200).json({ photos: {} });

        const rows = await prisma.$queryRaw<Array<{ id: string; photo: string | null }>>(Prisma.sql`
            SELECT e.id, COALESCE(e.profilePictureThumb, e.profilePictureUrl) AS photo
            FROM Employee e
            WHERE e.id IN (${Prisma.join(ids)})
              AND ${employeeScopeSql(tenantIds)}
              AND (e.profilePictureThumb IS NOT NULL OR e.profilePictureUrl IS NOT NULL)
        `);

        const photos: Record<string, string> = {};
        for (const row of rows) {
            if (row.photo) photos[String(row.id)] = String(row.photo);
        }
        res.status(200).json({ photos });
    } catch (error: any) {
        fail(res, 400, error.message);
    }
});

export default router;
