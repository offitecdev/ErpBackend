export class LeaveRequest {
    constructor(
        public id: string,
        public employeeId: string,
        public leaveTypeId: string,
        public startDate: Date,
        public endDate: Date,
        public totalDays: number,
        public status: 'Pending' | 'Approved' | 'Rejected',
        public description?: string | null,
        public approvedById?: string | null,
        public createdAt?: Date | null
    )  {}
}
