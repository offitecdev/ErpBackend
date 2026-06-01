export class AttendanceLog {
    constructor(
        public id: string,
        public employeeId: string,
        public logDate: Date,
        public checkInTime: Date,
        public checkOutTime: Date | null,
        public isManuelEdit: boolean = false,
        public editedById: string | null = null,
        public breakPeriodsJson: unknown = null,
        public netWorkSeconds: number | null = null
    ) {}
}