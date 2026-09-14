"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPersonName = exports.loadPersonRefs = exports.personDisplayName = exports.assertAssignablePeople = exports.getTasksAdminIds = exports.getTasksManagerIds = exports.invalidateTasksPeople = exports.getTasksPeople = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const serviceTenantScope_1 = require("../../../presentation/controllers/serviceTenantScope");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const PEOPLE_TTL_MS = 30_000;
const peopleCache = new Map();
const peopleInFlight = new Map();
const asFlag = (value) => value === true || value === 1 || value === '1' || (typeof value === 'bigint' && value === 1n);
const loadTasksPeople = async (tenantId) => {
    const scope = await (0, serviceTenantScope_1.getPersonnelTenantScope)(tenantId);
    if (!scope.length)
        return new Map();
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT e.id, e.firstName, e.lastName, e.title,
               GROUP_CONCAT(DISTINCT r.roleName ORDER BY r.roleName SEPARATOR ', ') AS roleNames,
               MAX(CASE WHEN r.isSystemAdmin = 1 THEN 1 ELSE 0 END) AS isAdmin,
               MAX(CASE WHEN p.permissionName = ${taskConstants_1.TASKS_PERMISSIONS.view} THEN 1 ELSE 0 END) AS canView,
               MAX(CASE WHEN p.permissionName = ${taskConstants_1.TASKS_PERMISSIONS.manage} THEN 1 ELSE 0 END) AS canManage,
               MAX(CASE WHEN p.permissionName = ${taskConstants_1.TASKS_PERMISSIONS.delete} THEN 1 ELSE 0 END) AS canDel
        FROM Employee e
        LEFT JOIN EmployeeRole er ON er.employeeId = e.id
        LEFT JOIN Role r ON r.id = er.roleId
        LEFT JOIN RolePermission rp ON rp.roleId = er.roleId
        LEFT JOIN Permission p ON p.id = rp.permissionId
            AND p.permissionName IN (${client_1.Prisma.join([taskConstants_1.TASKS_PERMISSIONS.view, taskConstants_1.TASKS_PERMISSIONS.manage, taskConstants_1.TASKS_PERMISSIONS.delete])})
        WHERE ${(0, serviceTenantScope_1.employeeScopeSql)(scope, 'e')}
          AND e.isActive = 1
          AND e.deletedAt IS NULL
        GROUP BY e.id, e.firstName, e.lastName, e.title
    `);
    const people = new Map();
    for (const row of rows) {
        const isAdmin = asFlag(Number(row.isAdmin));
        // Admin = nur die Administratorrolle (siehe taskActor); Stufe 3 ist Leitung.
        const canDelete = isAdmin;
        const isManager = isAdmin || asFlag(Number(row.canDel)) || asFlag(Number(row.canManage));
        if (!isManager && !asFlag(Number(row.canView)))
            continue;
        people.set(row.id, {
            id: row.id,
            firstName: row.firstName ?? '',
            lastName: row.lastName ?? '',
            title: row.title ?? null,
            roleName: row.roleNames ? String(row.roleNames) : null,
            isManager,
            canDelete,
        });
    }
    return people;
};
/** Wer in der ausgewählten Firma das Modul benutzen darf (aktiv, nicht gelöscht). */
const getTasksPeople = async (tenantId) => {
    const cached = peopleCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now())
        return cached.value;
    const pending = peopleInFlight.get(tenantId);
    if (pending)
        return pending;
    const request = loadTasksPeople(tenantId)
        .then((value) => {
        peopleCache.set(tenantId, { expiresAt: Date.now() + PEOPLE_TTL_MS, value });
        return value;
    })
        .finally(() => peopleInFlight.delete(tenantId));
    peopleInFlight.set(tenantId, request);
    return request;
};
exports.getTasksPeople = getTasksPeople;
const invalidateTasksPeople = (tenantId) => {
    if (tenantId)
        peopleCache.delete(tenantId);
    else
        peopleCache.clear();
};
exports.invalidateTasksPeople = invalidateTasksPeople;
/** Die Leitung der Firma (tasks.manage/delete oder Administratorrolle). */
const getTasksManagerIds = async (tenantId) => [...(await (0, exports.getTasksPeople)(tenantId)).values()].filter((person) => person.isManager).map((person) => person.id);
exports.getTasksManagerIds = getTasksManagerIds;
/** Die Administratorrolle der Firma (Empfänger von Görev-Talepen, Abschluss- und Löschanfragen). */
const getTasksAdminIds = async (tenantId) => [...(await (0, exports.getTasksPeople)(tenantId)).values()].filter((person) => person.canDelete).map((person) => person.id);
exports.getTasksAdminIds = getTasksAdminIds;
/**
 * Prüft Personen für eine Zuweisung (Aufgabe, Checklistenpunkt, Chat-Raum):
 * jede muss zur ausgewählten Firma gehören und das Modul benutzen dürfen.
 * Gibt die eindeutigen Kennungen in Eingangsreihenfolge zurück.
 */
const assertAssignablePeople = async (tenantId, ids) => {
    const wanted = [...new Set([...ids].map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (!wanted.length)
        return [];
    const people = await (0, exports.getTasksPeople)(tenantId);
    const missing = wanted.filter((id) => !people.has(id));
    if (missing.length) {
        throw (0, taskErrors_1.taskBadRequest)('PERSON_NOT_ASSIGNABLE', 'Diese Person gehört nicht zur ausgewählten Firma oder hat keinen Zugang zum Modul «Görevler».', { employeeIds: missing });
    }
    return wanted;
};
exports.assertAssignablePeople = assertAssignablePeople;
const personDisplayName = (person) => person ? `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() : '';
exports.personDisplayName = personDisplayName;
/**
 * Namen zu Kennungen, die aus den EIGENEN, bereits firmengeprüften Zeilen des
 * Moduls stammen — darum ohne Firmenfilter, und bewusst auch für ehemalige
 * Personen (ein alter Kommentar behält seinen Namen).
 */
const loadPersonRefs = async (ids) => {
    const unique = [...new Set([...ids].filter((id) => typeof id === 'string' && id.length > 0))];
    if (!unique.length)
        return {};
    const refs = {};
    for (let offset = 0; offset < unique.length; offset += 500) {
        const chunk = unique.slice(offset, offset + 500);
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT id, firstName, lastName, title, isActive, deletedAt
            FROM Employee
            WHERE id IN (${client_1.Prisma.join(chunk)})
        `);
        for (const row of rows) {
            const firstName = row.firstName ?? '';
            const lastName = row.lastName ?? '';
            refs[row.id] = {
                id: row.id,
                firstName,
                lastName,
                name: `${firstName} ${lastName}`.trim(),
                title: row.title ?? null,
                active: asFlag(Number(row.isActive)) && !row.deletedAt,
            };
        }
    }
    return refs;
};
exports.loadPersonRefs = loadPersonRefs;
/** Anzeigename EINER Person (für Benachrichtigungen und Systemnachrichten). */
const loadPersonName = async (employeeId) => (await (0, exports.loadPersonRefs)([employeeId]))[employeeId]?.name ?? '';
exports.loadPersonName = loadPersonName;
//# sourceMappingURL=taskPeople.js.map