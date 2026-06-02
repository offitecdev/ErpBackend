"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerActivity = void 0;
class CustomerActivity {
    id;
    customerId;
    employeeId;
    activityType;
    activityDate;
    description;
    referenceId;
    constructor(id, customerId, employeeId, activityType, activityDate, description, referenceId) {
        this.id = id;
        this.customerId = customerId;
        this.employeeId = employeeId;
        this.activityType = activityType;
        this.activityDate = activityDate;
        this.description = description;
        this.referenceId = referenceId;
    }
}
exports.CustomerActivity = CustomerActivity;
//# sourceMappingURL=CustomerActivitiy.js.map