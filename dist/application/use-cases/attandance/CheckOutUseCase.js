"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckOutUseCase = void 0;
const attendanceBreaks_1 = require("../../utils/attendanceBreaks");
class CheckOutUseCase {
    attendanceLogRepository;
    employeeRepository;
    tenantRepository;
    constructor(attendanceLogRepository, employeeRepository, tenantRepository) {
        this.attendanceLogRepository = attendanceLogRepository;
        this.employeeRepository = employeeRepository;
        this.tenantRepository = tenantRepository;
    }
    async execute(employeeId, qrPayload, opts) {
        const trimmed = (qrPayload ?? "").trim();
        if (!trimmed) {
            throw new Error("QR kodu okutulmadı veya geçersiz.");
        }
        const employee = await this.employeeRepository.findById(employeeId);
        if (!employee) {
            throw new Error("Employee not found");
        }
        const tenant = await this.tenantRepository.findById(employee.tenantId);
        if (!tenant) {
            throw new Error("Tenant not found");
        }
        const expectedIn = (tenant.checkInQrSecret ?? "").trim();
        const expectedOut = (tenant.checkOutQrSecret ?? "").trim();
        const fromToggle = opts?.fromCheckInToggle === true;
        if (fromToggle) {
            if (!expectedIn) {
                throw new Error("İstasyon QR anahtarı tanımlı değil. Yönetim panelinden (Mesai & QR) yapılandırın.");
            }
            if (trimmed !== expectedIn) {
                throw new Error("Geçersiz istasyon QR kodu.");
            }
        }
        else {
            if (!expectedOut) {
                throw new Error("Çıkış QR anahtarı tanımlı değil. Yönetim panelinden (Mesai & QR) yapılandırın.");
            }
            if (trimmed !== expectedOut) {
                throw new Error("Geçersiz çıkış QR kodu.");
            }
        }
        const activeLog = await this.attendanceLogRepository.findActiveCheckIn(employeeId);
        if (!activeLog) {
            // Check if there is a recently closed session (idempotency for double-clicks)
            const recentLogs = await this.attendanceLogRepository.findByEmployeeId(employeeId);
            if (recentLogs && recentLogs.length > 0) {
                const latestLog = recentLogs[0];
                if (latestLog && latestLog.checkOutTime) {
                    const diffMs = new Date().getTime() - new Date(latestLog.checkOutTime).getTime();
                    if (diffMs < 30000) { // 30 seconds
                        return latestLog; // Silently return the existing checkout rather than failing
                    }
                }
            }
            throw new Error("Aktif giriş kaydı bulunamadı (zaten çıkış yapılmış olabilir).");
        }
        const checkOutAt = new Date();
        let periods = (0, attendanceBreaks_1.parseBreakPeriods)(activeLog.breakPeriodsJson);
        periods = periods.map((p) => p.end === null ? { ...p, end: checkOutAt.toISOString() } : p);
        const netWorkSeconds = (0, attendanceBreaks_1.computeNetWorkSeconds)(activeLog.checkInTime, checkOutAt, periods);
        return await this.attendanceLogRepository.update(activeLog.id, {
            checkOutTime: checkOutAt,
            breakPeriodsJson: periods,
            netWorkSeconds,
        });
    }
}
exports.CheckOutUseCase = CheckOutUseCase;
//# sourceMappingURL=CheckOutUseCase.js.map