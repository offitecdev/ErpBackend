import { TaskStatus } from './Maintenance';

export class ServiceCall {
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string,
        public reportedIssue: string,
        public status: TaskStatus,
        public callDate: Date,
        public assignedTechId?: string | null,
        public alternativeTechId?: string | null,
        public siteName?: string | null,
        public priority?: string | null,
        public assignmentHistoryJson?: unknown | null,
        public updatedAt?: Date
    ) {}
}

export class ServiceReport {
    constructor(
        public id: string,
        public callId: string,
        public techId: string,
        public workDone: string,
        public workingMinutes: number,
        public gasAmount: number,
        public isWarranty: boolean,
        public isSigned: boolean,
        public customerSignature?: string | null,
        public observations?: string | null,
        public recommendations?: string | null,
        public beforePhotoUrls?: unknown | null,
        public afterPhotoUrls?: unknown | null,
        public fileUrls?: unknown | null,
        public signedAt?: Date | null,
        public lockedAt?: Date | null,
        public linkedOrderId?: string | null,
        public createdAt?: Date
    ) {}
}

export class ServiceMaterial {
    constructor(
        public id: string,
        public reportId: string,
        public articleId: string,
        public quantity: number,
        public unitCost: number,
        public sourceLocationId?: string | null
    ) {}
}
