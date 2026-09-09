export class Employee {
    
    constructor(
        public id: string,
        public tenantId: string,
        public firstName: string,
        public lastName: string,
        public email: string,
        public passwordHash: string,
        public isActive: boolean,
        public title?: string | null,
        public departmentId?: string | null,
        public roleName?: string | null,
        public phone?: string | null,
        public address?: string | null,
        public hireDate?: Date | null,
        public terminationDate?: Date | null,
        public annualLeaveEntitlement?: number,
        public profilePictureUrl?: string | null,
        public notes?: string | null,
        public createdAt?: Date | null,
        public updatedAt?: Date | null,
        public roleId?: string | null,
        public passwordChangedAt?: Date | null,
        public deletedAt?: Date | null,
        public bannedAt?: Date | null,
        /// Personal module package; null = no restriction.
        public moduleKeys?: string[] | null,
        /// Companies of the tree the employee may work in; null = no restriction.
        public allowedTenantIds?: string[] | null,
        /// Gesetzt, sobald die VERWALTUNG das Konto stillgelegt hat (pasif,
        /// gesperrt, gelöscht). Nur ein Konto OHNE diese Marke darf sich per
        /// Aktivierungslink selbst freischalten — siehe AccountActivationUseCases.
        public deactivatedAt?: Date | null,
        /// ── ZWEITER FAKTOR (TOTP / Aegis) ───────────────────────────────────
        /// Das gemeinsame Geheimnis mit der Authenticator-App — VERSCHLÜSSELT,
        /// so wie es in der Spalte steht (siehe totpCrypto.ts); wer damit
        /// rechnen will, muss es erst entschlüsseln.
        public totpSecret?: string | null,
        /// Zeitpunkt der ersten bestätigten Codeeingabe. null = noch nicht
        /// eingerichtet, die Anmeldung führt dann durch die Einrichtung.
        public totpEnabledAt?: Date | null,
        /// Zuletzt angenommenes Zeitfenster — ein Code gilt genau einmal.
        public totpLastStep?: number | null,
    )  {}
}
