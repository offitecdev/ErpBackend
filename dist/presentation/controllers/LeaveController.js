"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeaveController = void 0;
class LeaveController {
    createLeaveRequestUseCase;
    approveLeaveRequestUseCase;
    listLeavesUseCase;
    constructor(createLeaveRequestUseCase, approveLeaveRequestUseCase, listLeavesUseCase) {
        this.createLeaveRequestUseCase = createLeaveRequestUseCase;
        this.approveLeaveRequestUseCase = approveLeaveRequestUseCase;
        this.listLeavesUseCase = listLeavesUseCase;
    }
    async createLeaveRequest(req, res) {
        try {
            const { employeeId, leaveTypeId, startDate, endDate, description } = req.body;
            const leaveRequest = await this.createLeaveRequestUseCase.execute({
                employeeId,
                leaveTypeId,
                startDate,
                endDate,
                description
            });
            res.status(201).json(leaveRequest);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async evaluateLeaveRequest(req, res) {
        try {
            const { id } = req.params;
            const { isapproved, managerId } = req.body;
            const result = await this.approveLeaveRequestUseCase.execute(id, managerId, isapproved);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async list(req, res) {
        try {
            const filter = {};
            if (req.user?.tenantId)
                filter.tenantId = req.user.tenantId;
            if (req.query.all !== 'true' && req.user?.id)
                filter.employeeId = req.user.id;
            if (req.query.status)
                filter.status = req.query.status;
            const results = await this.listLeavesUseCase.execute(filter);
            res.status(200).json(results);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.LeaveController = LeaveController;
//# sourceMappingURL=LeaveController.js.map