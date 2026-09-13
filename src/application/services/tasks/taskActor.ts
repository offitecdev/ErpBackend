import { RoleRepository } from '../../../infrastructure/repositories/RoleRepository';
import { TASKS_PERMISSIONS } from './taskConstants';
import { taskForbidden } from './taskErrors';

/**
 * ── WER HANDELT IM GÖREVLER-MODUL ───────────────────────────────────────────
 *
 * Zwei Sichten wie in Görevly, abgeleitet aus den Rollenrechten der Person:
 *   • Leitung («Yönetici»)   — `tasks.manage` (oder `tasks.delete`): sieht alle
 *     Aufgaben der ausgewählten Firma, weist zu, entscheidet Anfragen, sieht
 *     Zeiten, Verlauf, Kişiler und alle Berichte.
 *   • Teammitglied («Ekip üyesi») — nur `tasks.view`: sieht, was ihm zugewiesen
 *     ist oder was es selbst angelegt hat, und nur den eigenen Bericht.
 *
 * Die Administratorrolle (`Role.isSystemAdmin`) zählt als Leitung mit
 * Löschrecht — auch bevor ensureSystemAdminRole die neuen Rechtenamen in ihre
 * Rolle geschrieben hat (das geschieht erst beim nächsten Öffnen der
 * Berechtigungen). Beide Lesungen kommen aus den 60-s-Zwischenspeichern der
 * RoleRepository, kosten also im Normalfall keinen Rundgang.
 */

export interface TasksActor {
    employeeId: string;
    /** Die AUSGEWÄHLTE Firma (req.user.tenantId). */
    tenantId: string;
    isManager: boolean;
    canDelete: boolean;
    /** Sieht ALLE Aufgaben der Firma: Leitung und Administratorrolle; Teammitglieder nur Zugewiesenes/Angelegtes. */
    seesAll: boolean;
    isSystemAdmin: boolean;
}

const roleRepository = new RoleRepository();

/** null = die Person darf das Modul nicht benutzen. */
export const resolveTasksActor = async (employeeId: string, tenantId: string): Promise<TasksActor | null> => {
    const [permissions, roleInfo] = await Promise.all([
        roleRepository.getEmployeePermissions(employeeId),
        roleRepository.getEmployeeRoleInfo(employeeId),
    ]);
    const has = (name: string) => permissions.includes(name);
    const isSystemAdmin = roleInfo.isSystemAdmin;
    /* NUR DIE ADMINISTRATORROLLE (13.09.2026, Samet: «Tamamlama onayı sadece
       Administrator — rollerdeki en üst rol; diğerleri talep»). Abschluss
       bestätigen/ablehnen, direkt abschliessen, löschen und alles sehen hängt an
       `Role.isSystemAdmin` (genau eine Rolle je Firmenbaum), NICHT mehr an
       `tasks.delete` — eine Rolle mit Stufe 3 ist Leitung, kein Admin. */
    const canDelete = isSystemAdmin;
    const isManager = isSystemAdmin || has(TASKS_PERMISSIONS.delete) || has(TASKS_PERMISSIONS.manage);
    const canView = isManager || has(TASKS_PERMISSIONS.view);
    if (!canView) return null;
    /* ALLE AUFGABEN SEHEN (13.09.2026, Samet: «yönetici tüm görevleri görebilmeli,
       Administrator tüm görevleri görebilmeli»): Leitung UND Administratorrolle.
       Teammitglieder sehen weiter nur Zugewiesenes und selbst Angelegtes. */
    return { employeeId, tenantId, isManager, canDelete, seesAll: isManager, isSystemAdmin };
};

export const assertManager = (actor: TasksActor): void => {
    if (!actor.isManager) throw taskForbidden('MANAGER_ONLY', 'Das darf nur die Leitung.');
};

/** Firmenweite Übersichten (Team-Rapport, alle Personen): nur Admins. */
export const assertSeesAll = (actor: TasksActor): void => {
    if (!actor.seesAll) throw taskForbidden('ADMIN_ONLY', 'Das dürfen nur Admins.');
};

/**
 * Seiten nur für die Administratorrolle (13.09.2026, Samet: «Administrator'da
 * bütün menüler açık, diğer rollerde sadece Görevler ve Sohbet»): Canlı,
 * Onaylar, Kişiler, Raporlar.
 */
export const assertSystemAdmin = (actor: TasksActor): void => {
    if (!actor.isSystemAdmin) throw taskForbidden('ADMIN_ONLY', 'Das dürfen nur Admins.');
};

/** Abschluss bestätigen/ablehnen oder direkt abschliessen: nur die Administratorrolle. */
export const assertCompletionAdmin = (actor: TasksActor): void => {
    if (!actor.isSystemAdmin) {
        throw taskForbidden('COMPLETION_ADMIN_ONLY', 'Den Abschluss bestätigt nur die Administratorrolle.');
    }
};

export const assertCanDelete = (actor: TasksActor): void => {
    if (!actor.canDelete) throw taskForbidden('DELETE_FORBIDDEN', 'Zum Löschen fehlt die Berechtigung.');
};
