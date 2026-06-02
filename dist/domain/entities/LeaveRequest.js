"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeaveRequest = void 0;
class LeaveRequest {
    id;
    employeeId;
    leaveTypeId;
    startDate;
    endDate;
    totalDays;
    status;
    description;
    approvedById;
    createdAt;
    constructor(id, employeeId, leaveTypeId, startDate, endDate, totalDays, status, description, approvedById, createdAt) {
        this.id = id;
        this.employeeId = employeeId;
        this.leaveTypeId = leaveTypeId;
        this.startDate = startDate;
        this.endDate = endDate;
        this.totalDays = totalDays;
        this.status = status;
        this.description = description;
        this.approvedById = approvedById;
        this.createdAt = createdAt;
    }
}
exports.LeaveRequest = LeaveRequest;
//# sourceMappingURL=LeaveRequest.js.map