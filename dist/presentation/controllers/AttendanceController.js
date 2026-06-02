"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttendanceController = void 0;
require("../middlewares/AuthMiddleware"); // Import for req.user type augmentation
class AttendanceController {
    checkInUseCase;
    checkOutUseCase;
    startBreakUseCase;
    endBreakUseCase;
    listAttendanceUseCase;
    updateAttendanceUseCase;
    getMeUseCase;
    constructor(checkInUseCase, checkOutUseCase, startBreakUseCase, endBreakUseCase, listAttendanceUseCase, updateAttendanceUseCase, getMeUseCase) {
        this.checkInUseCase = checkInUseCase;
        this.checkOutUseCase = checkOutUseCase;
        this.startBreakUseCase = startBreakUseCase;
        this.endBreakUseCase = endBreakUseCase;
        this.listAttendanceUseCase = listAttendanceUseCase;
        this.updateAttendanceUseCase = updateAttendanceUseCase;
        this.getMeUseCase = getMeUseCase;
    }
    async checkIn(req, res) {
        try {
            const employeeId = req.user.id;
            const qrPayload = typeof req.body?.qrPayload === "string" ? req.body.qrPayload : "";
            const result = await this.checkInUseCase.execute(employeeId, qrPayload);
            const closed = result.checkOutTime != null;
            res.status(closed ? 200 : 201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async checkOut(req, res) {
        try {
            const employeeId = req.user.id;
            const qrPayload = typeof req.body?.qrPayload === "string" ? req.body.qrPayload : "";
            const result = await this.checkOutUseCase.execute(employeeId, qrPayload);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async startBreak(req, res) {
        try {
            const result = await this.startBreakUseCase.execute(req.user.id);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async endBreak(req, res) {
        try {
            const result = await this.endBreakUseCase.execute(req.user.id);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async list(req, res) {
        try {
            const filter = {
                tenantId: req.user.tenantId,
                employeeId: req.query.employeeId,
                date: req.query.date,
                startDate: req.query.startDate,
                endDate: req.query.endDate
            };
            const result = await this.listAttendanceUseCase.execute(filter);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const id = req.params.id;
            const { checkInTime, checkOutTime } = req.body;
            const editedById = req.user.id;
            const result = await this.updateAttendanceUseCase.execute(id, checkInTime, checkOutTime, editedById);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getMe(req, res) {
        try {
            const employeeId = req.user?.id;
            if (!employeeId)
                return res.status(401).json({ error: 'Yetkisiz.' });
            const result = await this.getMeUseCase.execute(employeeId);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.AttendanceController = AttendanceController;
//# sourceMappingURL=AttendanceController.js.map