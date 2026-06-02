"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttendanceLog = void 0;
class AttendanceLog {
    id;
    employeeId;
    logDate;
    checkInTime;
    checkOutTime;
    isManuelEdit;
    editedById;
    breakPeriodsJson;
    netWorkSeconds;
    constructor(id, employeeId, logDate, checkInTime, checkOutTime, isManuelEdit = false, editedById = null, breakPeriodsJson = null, netWorkSeconds = null) {
        this.id = id;
        this.employeeId = employeeId;
        this.logDate = logDate;
        this.checkInTime = checkInTime;
        this.checkOutTime = checkOutTime;
        this.isManuelEdit = isManuelEdit;
        this.editedById = editedById;
        this.breakPeriodsJson = breakPeriodsJson;
        this.netWorkSeconds = netWorkSeconds;
    }
}
exports.AttendanceLog = AttendanceLog;
//# sourceMappingURL=AttendanceLog.js.map