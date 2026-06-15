export type MaintenancePeriod = 'MONTHLY' | 'QUARTERLY' | 'BIANNUAL' | 'YEARLY';
export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type MaintenanceAppointmentOptionStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'EXPIRED';

export class MaintenanceContract {
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string,
        public title: string,
        public period: MaintenancePeriod,
        public startDate: Date,
        public endDate: Date,
        public contractCode?: string | null,
        public equipmentInfo?: string | null,
        public serviceScope?: string | null,
        public siteName?: string | null,
        public reminderDaysBefore: number = 7,
        public notificationChannels?: unknown | null,
        public overtimeHourlyRate: number = 0,
        public isActive: boolean = true,
        public deletedAt?: Date | null,
        public createdAt?: Date,
        public updatedAt?: Date
    ) {}
}

export class MaintenanceTask {
    constructor(
        public id: string,
        public contractId: string,
        public plannedDate: Date,
        public status: TaskStatus,
        public assignedTechId?: string | null,
        public alternativeTechId?: string | null,
        public siteName?: string | null,
        public scheduledStartTime?: Date | null,
        public scheduledEndTime?: Date | null,
        public bookingToken?: string | null,
        public reminderSentAt?: Date | null,
        public managerApprovedAt?: Date | null,
        public managerApprovedById?: string | null,
        public assignmentHistoryJson?: unknown | null,
        public createdAt?: Date,
        public updatedAt?: Date
    ) {}
}

export class MaintenanceReport {
    constructor(
        public id: string,
        public taskId: string,
        public techId: string,
        public operationsDone: string,
        public isSigned: boolean,
        public checklistJson?: unknown | null,
        public observations?: string | null,
        public recommendations?: string | null,
        public riskNotes?: string | null,
        public beforePhotoUrls?: unknown | null,
        public afterPhotoUrls?: unknown | null,
        public fileUrls?: unknown | null,
        public customerSignature?: string | null,
        public signedAt?: Date | null,
        public lockedAt?: Date | null,
        public pdfUrl?: string | null,
        public emailSentAt?: Date | null,
        public emailLogJson?: unknown | null,
        public createdAt?: Date
    ) {}
}

export class MaintenanceTaskAssignment {
    constructor(
        public id: string,
        public taskId: string,
        public technicianId: string,
        public assignedAt?: Date,
        public createdById?: string | null
    ) {}
}

export class MaintenanceAppointmentOption {
    constructor(
        public id: string,
        public taskId: string,
        public token: string,
        public startTime: Date,
        public endTime: Date,
        public status: MaintenanceAppointmentOptionStatus,
        public sentAt?: Date | null,
        public respondedAt?: Date | null,
        public emailLogJson?: unknown | null,
        public createdAt?: Date,
        public isAvailable?: boolean,
        public unavailableReason?: string | null
    ) {}
}

export class MaintenanceExpense {
    constructor(
        public id: string,
        public taskId: string,
        public expenseType: string,
        public amount: number,
        public reportId?: string | null,
        public description?: string | null,
        public createdAt?: Date
    ) {}
}

export class MaintenanceMaterial {
    constructor(
        public id: string,
        public reportId: string,
        public articleId: string,
        public quantity: number,
        public unitCost: number,
        public sourceLocationId?: string | null
    ) {}
}
