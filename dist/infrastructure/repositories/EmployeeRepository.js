"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const Employee_1 = require("../../domain/entities/Employee");
const authIdentityCache_1 = require("../../shared/authIdentityCache");
const RefreshSessionService_1 = require("../services/RefreshSessionService");
const staffDirectoryCache_1 = require("../../shared/staffDirectoryCache");
class EmployeeRepository {
    mapToEntity(data) {
        const firstRole = data.employeeRoles?.[0]?.role;
        const emp = new Employee_1.Employee(data.id, data.tenantId, data.firstName, data.lastName, data.email, data.passwordHash, data.isActive, data.title, data.departmentId, firstRole?.roleName ?? data.roleName, data.phone, data.address, data.hireDate, data.terminationDate, data.annualLeaveEntitlement, data.profilePictureUrl, data.notes, data.createdAt, data.updatedAt, firstRole?.id ?? null, data.passwordChangedAt, data.deletedAt, data.bannedAt, Array.isArray(data.moduleKeys) ? data.moduleKeys : null, Array.isArray(data.allowedTenantIds) ? data.allowedTenantIds : null, data.deactivatedAt ?? null, data.totpSecret ?? null, data.totpEnabledAt ?? null, data.totpLastStep ?? null);
        return emp;
    }
    roleInclude = {
        employeeRoles: { include: { role: true } }
    };
    async findByEmail(email) {
        const data = await prisma_client_1.default.employee.findUnique({
            where: { email },
            include: this.roleInclude,
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findById(id) {
        const data = await prisma_client_1.default.employee.findUnique({
            where: { id },
            include: this.roleInclude,
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findAll(filters) {
        const whereClause = filters.tenantIds?.length
            ? { tenantId: { in: filters.tenantIds } }
            : { tenantId: filters.tenantId };
        if (filters.isActive !== undefined)
            whereClause.isActive = filters.isActive;
        if (filters.departmentId)
            whereClause.departmentId = filters.departmentId;
        const andConditions = [];
        if (filters.roleName) {
            andConditions.push({
                OR: [
                    { roleName: filters.roleName },
                    { employeeRoles: { some: { role: { roleName: filters.roleName } } } },
                ],
            });
        }
        if (filters.search) {
            andConditions.push({
                OR: [
                    { firstName: { contains: filters.search } },
                    { lastName: { contains: filters.search } },
                    { email: { contains: filters.search } },
                    { phone: { contains: filters.search } }
                ],
            });
        }
        if (andConditions.length)
            whereClause.AND = andConditions;
        const data = await prisma_client_1.default.employee.findMany({
            where: whereClause,
            orderBy: { createdAt: 'desc' },
            include: this.roleInclude,
        });
        return data.map(d => this.mapToEntity(d));
    }
    async create(employeeData) {
        const { roleId, ...coreData } = employeeData;
        const createData = {
            // Die Kennung wird HIER vergeben, nie aus der Anfrage übernommen:
            // `Employee.id` hat keinen Vorgabewert im Schema, und eine selbst
            // gewählte Kennung ist ein Einfallstor (sie taucht in jeder
            // Fremdschlüssel-Beziehung wieder auf). Dieselbe Form wie im
            // Personalmodul, das `prisma.employee.create` unmittelbar ruft.
            id: (0, nanoid_1.nanoid)(),
            tenantId: coreData.tenantId,
            firstName: coreData.firstName,
            lastName: coreData.lastName,
            email: coreData.email,
            passwordHash: coreData.passwordHash,
            isActive: coreData.isActive ?? true,
            title: coreData.title ?? null,
            departmentId: coreData.departmentId ?? null,
            roleName: coreData.roleName ?? null,
            phone: coreData.phone ?? null,
            address: coreData.address ?? null,
            hireDate: coreData.hireDate ?? null,
            terminationDate: coreData.terminationDate ?? null,
            annualLeaveEntitlement: coreData.annualLeaveEntitlement ?? 0,
            profilePictureUrl: coreData.profilePictureUrl ?? null,
            notes: coreData.notes ?? null,
            moduleKeys: coreData.moduleKeys ?? undefined,
            allowedTenantIds: coreData.allowedTenantIds ?? undefined,
        };
        if (roleId) {
            createData.employeeRoles = {
                create: {
                    roleId
                }
            };
        }
        const data = await prisma_client_1.default.employee.create({
            data: createData
        });
        // Die Personal-Kurzliste der Auswahlfelder ist kurz zwischengespeichert;
        // ohne diesen Aufruf fehlte die neue Person dort bis zum Ablauf der Frist.
        (0, staffDirectoryCache_1.invalidateStaffDirectory)();
        return this.mapToEntity(data);
    }
    /**
     * VERTRAUTER WEG: die Aufrufer geben ausgewählte Felder herein, nie einen
     * Anfragekörper (siehe WRITABLE_EMPLOYEE_FIELDS im EmployeeController). Die
     * Zugangsfelder — `passwordHash`, `passwordChangedAt`, `deletedAt`,
     * `bannedAt` — müssen hier durchkommen, weil genau diese Stelle sie für den
     * Kennwortweg, die Sperre und das Löschen schreibt.
     *
     * Abgestreift wird, was NIEMAND über diesen Weg zu ändern hat: die Kennung
     * und die Firma (sie bestimmen, wem der Datensatz gehört), die Rolle (sie
     * hängt an EmployeeRole), sowie der QR-Schlüssel und die Personalnummer —
     * beide werden ausschliesslich im Personalmodul vergeben, und der QR-Schlüssel
     * ist eine Zugangsangabe (er meldet ohne Kennwort an).
     */
    async update(id, updateData) {
        const { id: _id, tenantId: _tid, roleId: _roleId, qrToken: _qrToken, staffNumber: _staffNumber, ...safeData } = updateData;
        // Json? columns cannot be cleared with plain null.
        if (safeData.moduleKeys === null)
            safeData.moduleKeys = client_1.Prisma.DbNull;
        if (safeData.allowedTenantIds === null)
            safeData.allowedTenantIds = client_1.Prisma.DbNull;
        /* ── STILLGELEGT ODER NOCH NIE FREIGESCHALTET? ───────────────────────
           Die Marke wird HIER gepflegt und nirgends sonst: jeder Weg, der ein
           Konto stilllegt (Pasif setzen, Sperren, Löschen) und jeder, der es
           wieder öffnet, läuft durch diese Methode. An den Endpunkten einzeln
           gesetzt wäre sie beim nächsten neuen Endpunkt vergessen — und ein
           vergessenes `deactivatedAt` heisst: die ausgetretene Person schaltet
           sich per Aktivierungslink selbst wieder frei. */
        if (safeData.deactivatedAt === undefined) {
            if (safeData.isActive === false)
                safeData.deactivatedAt = new Date();
            else if (safeData.isActive === true)
                safeData.deactivatedAt = null;
        }
        const data = await prisma_client_1.default.employee.update({
            where: { id },
            data: safeData,
            include: this.roleInclude,
        });
        // Ban / pasifleştirme / silme / parola değişimi / şirket ataması — hepsi
        // buradan geçer. Önbelleği hemen düşür ki oturum kontrolü bir sonraki
        // istekte güncel durumu görsün.
        (0, authIdentityCache_1.invalidateAuthIdentity)(id);
        /* Und dieselben Ereignisse beenden die offenen ANMELDUNGEN. Das
           Zugangstoken stirbt ohnehin binnen 15 Minuten an der Zustandsprüfung
           in `requireAuth`; ohne diesen Aufruf bliebe aber die Zeile des
           Erneuerungstokens offen stehen, und eine gesperrte Person hätte beim
           Entsperren ihre alte Sitzung zurück. Fehlschläge dürfen den
           Schreibvorgang nicht umwerfen — sie werden protokolliert. */
        if (safeData.bannedAt
            || safeData.deletedAt
            || safeData.passwordChangedAt
            || safeData.passwordHash
            || safeData.isActive === false) {
            void (0, RefreshSessionService_1.revokeAllRefreshSessions)(id, 'account').catch((error) => console.error('[EmployeeRepository] Sitzungen konnten nicht beendet werden:', error?.message || error));
        }
        // Name, Rolle, aktiv/gesperrt — all das steht in der Kurzliste der
        // Auswahlfelder. Jeder Schreibweg läuft hier durch, deshalb genügt
        // dieser eine Ort statt eines Aufrufs je Endpunkt.
        (0, staffDirectoryCache_1.invalidateStaffDirectory)();
        return this.mapToEntity(data);
    }
}
exports.EmployeeRepository = EmployeeRepository;
//# sourceMappingURL=EmployeeRepository.js.map