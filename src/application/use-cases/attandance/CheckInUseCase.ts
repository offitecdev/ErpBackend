import { nanoid } from "nanoid";

import { IAttendanceLogRepository } from "../../../domain/repositories/IAttendanceLogRepository";

import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";

import { ITenantRepository } from "../../../domain/repositories/ITenantRepository";

import { CheckOutUseCase } from "./CheckOutUseCase";



export class CheckInUseCase {

    constructor(

        private attendanceLogRepository: IAttendanceLogRepository,

        private employeeRepository: IEmployeeRepository,

        private tenantRepository: ITenantRepository,

        private checkOutUseCase: CheckOutUseCase

    ) {}



    async execute(employeeId: string, qrPayload: string) {

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

        if (!expectedIn && !expectedOut) {

            throw new Error(

                "QR anahtarı tanımlı değil. Yönetim panelinden (Mesai & QR) yapılandırın."

            );

        }



        const matchesIn = !!expectedIn && trimmed === expectedIn;

        const matchesOut = !!expectedOut && trimmed === expectedOut;

        if (!matchesIn && !matchesOut) {

            throw new Error("Geçersiz QR kodu.");

        }



        const activeLog = await this.attendanceLogRepository.findActiveCheckIn(employeeId);



        if (matchesIn) {

            if (activeLog) {

                return await this.checkOutUseCase.execute(employeeId, qrPayload, {

                    fromCheckInToggle: true,

                });

            }

            if (!employee.isActive) {

                throw new Error("Employee is not active");

            }

            return await this.attendanceLogRepository.create({

                id: nanoid(12),

                employeeId: employeeId,

                logDate: new Date(),

                checkInTime: new Date(),

                breakPeriodsJson: [],

            });

        }



        if (!activeLog) {

            throw new Error("Aktif giriş kaydı yok.");

        }

        return await this.checkOutUseCase.execute(employeeId, qrPayload);

    }

}

