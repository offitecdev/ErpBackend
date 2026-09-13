import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import { employeeScopeSql, getPersonnelTenantScope } from '../../../presentation/controllers/serviceTenantScope';
import { TASKS_PERMISSIONS } from './taskConstants';
import { taskBadRequest } from './taskErrors';

/**
 * ── PERSONEN IM GÖREVLER-MODUL ──────────────────────────────────────────────
 *
 * Vorgabe Samet: «sistem bizim personelleri kullanacaksınız … sadece
 * kendimize ait personelleri». Personen sind das Personal der AUSGEWÄHLTEN
 * Firma (getPersonnelTenantScope: Heimatfirma ODER zugeteilt) — und davon nur,
 * wer das Modul auch öffnen darf. Wer keine Berechtigung hat, kann eine ihm
 * zugewiesene Aufgabe nicht sehen; ihn zuzuweisen hiesse, eine Meldung auf
 * eine gesperrte Seite zu schicken.
 *
 * Die Liste kostet einen Join über Rollen und Rechte; sie wird je Firma 30 s
 * gehalten (wie das Personalverzeichnis), gleichzeitige Anfragen teilen sich
 * EINE Abfrage.
 */

export interface TasksPerson {
    id: string;
    firstName: string;
    lastName: string;
    title: string | null;
    isManager: boolean;
    canDelete: boolean;
}

/** Anzeige einer Person in Antworten — auch für ehemalige (inaktiv/gelöscht). */
export interface PersonRef {
    id: string;
    firstName: string;
    lastName: string;
    name: string;
    title: string | null;
    active: boolean;
}

const PEOPLE_TTL_MS = 30_000;
const peopleCache = new Map<string, { expiresAt: number; value: Map<string, TasksPerson> }>();
const peopleInFlight = new Map<string, Promise<Map<string, TasksPerson>>>();

const asFlag = (value: unknown): boolean =>
    value === true || value === 1 || value === '1' || (typeof value === 'bigint' && value === 1n);

const loadTasksPeople = async (tenantId: string): Promise<Map<string, TasksPerson>> => {
    const scope = await getPersonnelTenantScope(tenantId);
    if (!scope.length) return new Map();
    const rows = await prisma.$queryRaw<Array<{
        id: string;
        firstName: string;
        lastName: string;
        title: string | null;
        isAdmin: unknown;
        canView: unknown;
        canManage: unknown;
        canDel: unknown;
    }>>(Prisma.sql`
        SELECT e.id, e.firstName, e.lastName, e.title,
               MAX(CASE WHEN r.isSystemAdmin = 1 THEN 1 ELSE 0 END) AS isAdmin,
               MAX(CASE WHEN p.permissionName = ${TASKS_PERMISSIONS.view} THEN 1 ELSE 0 END) AS canView,
               MAX(CASE WHEN p.permissionName = ${TASKS_PERMISSIONS.manage} THEN 1 ELSE 0 END) AS canManage,
               MAX(CASE WHEN p.permissionName = ${TASKS_PERMISSIONS.delete} THEN 1 ELSE 0 END) AS canDel
        FROM Employee e
        LEFT JOIN EmployeeRole er ON er.employeeId = e.id
        LEFT JOIN Role r ON r.id = er.roleId
        LEFT JOIN RolePermission rp ON rp.roleId = er.roleId
        LEFT JOIN Permission p ON p.id = rp.permissionId
            AND p.permissionName IN (${Prisma.join([TASKS_PERMISSIONS.view, TASKS_PERMISSIONS.manage, TASKS_PERMISSIONS.delete])})
        WHERE ${employeeScopeSql(scope, 'e')}
          AND e.isActive = 1
          AND e.deletedAt IS NULL
        GROUP BY e.id, e.firstName, e.lastName, e.title
    `);

    const people = new Map<string, TasksPerson>();
    for (const row of rows) {
        const isAdmin = asFlag(Number(row.isAdmin));
        // Admin = nur die Administratorrolle (siehe taskActor); Stufe 3 ist Leitung.
        const canDelete = isAdmin;
        const isManager = isAdmin || asFlag(Number(row.canDel)) || asFlag(Number(row.canManage));
        if (!isManager && !asFlag(Number(row.canView))) continue;
        people.set(row.id, {
            id: row.id,
            firstName: row.firstName ?? '',
            lastName: row.lastName ?? '',
            title: row.title ?? null,
            isManager,
            canDelete,
        });
    }
    return people;
};

/** Wer in der ausgewählten Firma das Modul benutzen darf (aktiv, nicht gelöscht). */
export const getTasksPeople = async (tenantId: string): Promise<Map<string, TasksPerson>> => {
    const cached = peopleCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = peopleInFlight.get(tenantId);
    if (pending) return pending;
    const request = loadTasksPeople(tenantId)
        .then((value) => {
            peopleCache.set(tenantId, { expiresAt: Date.now() + PEOPLE_TTL_MS, value });
            return value;
        })
        .finally(() => peopleInFlight.delete(tenantId));
    peopleInFlight.set(tenantId, request);
    return request;
};

export const invalidateTasksPeople = (tenantId?: string): void => {
    if (tenantId) peopleCache.delete(tenantId);
    else peopleCache.clear();
};

/** Die Leitung der Firma (Empfänger von Vorschlägen und Abschlussanfragen). */
export const getTasksManagerIds = async (tenantId: string): Promise<string[]> =>
    [...(await getTasksPeople(tenantId)).values()].filter((person) => person.isManager).map((person) => person.id);

/** Die Admins der Firma (Empfänger von Löschanfragen). */
export const getTasksAdminIds = async (tenantId: string): Promise<string[]> =>
    [...(await getTasksPeople(tenantId)).values()].filter((person) => person.canDelete).map((person) => person.id);

/**
 * Prüft Personen für eine Zuweisung (Aufgabe, Checklistenpunkt, Chat-Raum):
 * jede muss zur ausgewählten Firma gehören und das Modul benutzen dürfen.
 * Gibt die eindeutigen Kennungen in Eingangsreihenfolge zurück.
 */
export const assertAssignablePeople = async (tenantId: string, ids: Iterable<string>): Promise<string[]> => {
    const wanted = [...new Set([...ids].map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (!wanted.length) return [];
    const people = await getTasksPeople(tenantId);
    const missing = wanted.filter((id) => !people.has(id));
    if (missing.length) {
        throw taskBadRequest(
            'PERSON_NOT_ASSIGNABLE',
            'Diese Person gehört nicht zur ausgewählten Firma oder hat keinen Zugang zum Modul «Görevler».',
            { employeeIds: missing },
        );
    }
    return wanted;
};

export const personDisplayName = (person: { firstName?: string | null; lastName?: string | null } | null | undefined): string =>
    person ? `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() : '';

/**
 * Namen zu Kennungen, die aus den EIGENEN, bereits firmengeprüften Zeilen des
 * Moduls stammen — darum ohne Firmenfilter, und bewusst auch für ehemalige
 * Personen (ein alter Kommentar behält seinen Namen).
 */
export const loadPersonRefs = async (ids: Iterable<string | null | undefined>): Promise<Record<string, PersonRef>> => {
    const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (!unique.length) return {};
    const refs: Record<string, PersonRef> = {};
    for (let offset = 0; offset < unique.length; offset += 500) {
        const chunk = unique.slice(offset, offset + 500);
        const rows = await prisma.$queryRaw<Array<{
            id: string;
            firstName: string | null;
            lastName: string | null;
            title: string | null;
            isActive: unknown;
            deletedAt: Date | null;
        }>>(Prisma.sql`
            SELECT id, firstName, lastName, title, isActive, deletedAt
            FROM Employee
            WHERE id IN (${Prisma.join(chunk)})
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

/** Anzeigename EINER Person (für Benachrichtigungen und Systemnachrichten). */
export const loadPersonName = async (employeeId: string): Promise<string> =>
    (await loadPersonRefs([employeeId]))[employeeId]?.name ?? '';
