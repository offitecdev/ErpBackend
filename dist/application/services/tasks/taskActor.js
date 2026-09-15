"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertCanDelete = exports.assertCompletionAdmin = exports.assertSystemAdmin = exports.assertSeesAll = exports.assertManager = exports.resolveTasksActor = void 0;
const RoleRepository_1 = require("../../../infrastructure/repositories/RoleRepository");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const roleRepository = new RoleRepository_1.RoleRepository();
/** null = die Person darf das Modul nicht benutzen. */
const resolveTasksActor = async (employeeId, tenantId) => {
    const [permissions, roleInfo] = await Promise.all([
        roleRepository.getEmployeePermissions(employeeId),
        roleRepository.getEmployeeRoleInfo(employeeId),
    ]);
    const has = (name) => permissions.includes(name);
    const isSystemAdmin = roleInfo.isSystemAdmin;
    /* NUR DIE ADMINISTRATORROLLE (13.09.2026, Samet: «Tamamlama onayı sadece
       Administrator — rollerdeki en üst rol; diğerleri talep»). Abschluss
       bestätigen/ablehnen, direkt abschliessen, löschen und alles sehen hängt an
       `Role.isSystemAdmin` (genau eine Rolle je Firmenbaum), NICHT mehr an
       `tasks.delete` — eine Rolle mit Stufe 3 ist Leitung, kein Admin. */
    const canDelete = isSystemAdmin;
    const isManager = isSystemAdmin || has(taskConstants_1.TASKS_PERMISSIONS.delete) || has(taskConstants_1.TASKS_PERMISSIONS.manage);
    const canView = isManager || has(taskConstants_1.TASKS_PERMISSIONS.view);
    if (!canView)
        return null;
    /* ALLE AUFGABEN SEHEN — NUR DIE ADMINISTRATORROLLE (15.09.2026, Samet:
       «administratör rolü olmadığı sürece, mühendis ya da diğer roller sadece
       kendisine atanan görevi görebilmeli»). Supersedes 13.09 (Leitung sah alles). */
    return { employeeId, tenantId, isManager, canDelete, seesAll: isSystemAdmin, isSystemAdmin };
};
exports.resolveTasksActor = resolveTasksActor;
const assertManager = (actor) => {
    if (!actor.isManager)
        throw (0, taskErrors_1.taskForbidden)('MANAGER_ONLY', 'Das darf nur die Leitung.');
};
exports.assertManager = assertManager;
/** Firmenweite Übersichten (Team-Rapport, alle Personen): nur Admins. */
const assertSeesAll = (actor) => {
    if (!actor.seesAll)
        throw (0, taskErrors_1.taskForbidden)('ADMIN_ONLY', 'Das dürfen nur Admins.');
};
exports.assertSeesAll = assertSeesAll;
/**
 * Seiten nur für die Administratorrolle (13.09.2026, Samet: «Administrator'da
 * bütün menüler açık, diğer rollerde sadece Görevler ve Sohbet»): Canlı,
 * Onaylar, Kişiler, Raporlar.
 */
const assertSystemAdmin = (actor) => {
    if (!actor.isSystemAdmin)
        throw (0, taskErrors_1.taskForbidden)('ADMIN_ONLY', 'Das dürfen nur Admins.');
};
exports.assertSystemAdmin = assertSystemAdmin;
/** Abschluss bestätigen/ablehnen oder direkt abschliessen: nur die Administratorrolle. */
const assertCompletionAdmin = (actor) => {
    if (!actor.isSystemAdmin) {
        throw (0, taskErrors_1.taskForbidden)('COMPLETION_ADMIN_ONLY', 'Den Abschluss bestätigt nur die Administratorrolle.');
    }
};
exports.assertCompletionAdmin = assertCompletionAdmin;
const assertCanDelete = (actor) => {
    if (!actor.canDelete)
        throw (0, taskErrors_1.taskForbidden)('DELETE_FORBIDDEN', 'Zum Löschen fehlt die Berechtigung.');
};
exports.assertCanDelete = assertCanDelete;
//# sourceMappingURL=taskActor.js.map