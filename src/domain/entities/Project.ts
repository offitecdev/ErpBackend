export type ProjectStatus = 'AWAITING_APPROVAL' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type AppointmentStatus = 'AVAILABLE' | 'BOOKED' | 'COMPLETED' | 'CANCELLED';

export class Project {
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string,
        public projectName: string,
        public status: ProjectStatus,
        public plannedBudget: number,
        public actualCost: number,
        public createdAt: Date,
        public tenderId?: string | null,
        public managerId?: string | null,
        public startDate?: Date | null,
        public endDate?: Date | null,
        public bookingToken?: string | null,
        public overtimeHourlyRate?: number,
        public overtimeTolerancePercent?: number
    ) {}
}

export class ProjectPhase {
    constructor(
        public id: string,
        public projectId: string,
        public phaseName: string,
        public progressPercentage: number,
        public isCompleted: boolean
    ) {}
}

export class Appointment {
    constructor(
        public id: string,
        public tenantId: string,
        public startTime: Date,
        public endTime: Date,
        public status: AppointmentStatus,
        public projectId?: string | null,
        public customerId?: string | null,
        public notes?: string | null
    ) {}
}

export class ProjectReport {
    constructor(
        public id: string,
        public projectId: string,
        public salesOrderId: string | null,
        public appointmentId: string | null,
        public employeeId: string,
        public reportDate: Date,
        public reportType: string,
        public workedMinutes: number,
        public operationsDone: string,
        public isSigned: boolean,
        public workDate?: Date | null,
        public startedAt?: Date | null,
        public endedAt?: Date | null,
        public plannedMinutesForDay?: number,
        public overtimeMinutes?: number,
        public overtimeHourlyRate?: number,
        public overtimeCost?: number,
        public technicalNotes?: string | null,
        public customerSignature?: string | null
    ) {}
}

export class ReportMaterial {
    constructor(
        public id: string,
        public reportId: string,
        public articleId: string,
        public quantity: number,
        public costAtTime: number
    ) {}
}

export class ProjectExpense {
    constructor(
        public id: string,
        public projectId: string,
        public salesOrderId: string | null,
        public appointmentId: string | null,
        public expenseType: string,
        public amount: number,
        public expenseDate: Date,
        public description?: string | null
    ) {}
}
