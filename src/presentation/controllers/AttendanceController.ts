import { Request, Response } from 'express';
import '../middlewares/AuthMiddleware'; // Import for req.user type augmentation
import { CheckInUseCase } from '../../application/use-cases/attandance/CheckInUseCase';
import { CheckOutUseCase } from '../../application/use-cases/attandance/CheckOutUseCase';
import { StartBreakUseCase } from '../../application/use-cases/attandance/StartBreakUseCase';
import { EndBreakUseCase } from '../../application/use-cases/attandance/EndBreakUseCase';
import { ListAttendanceUseCase } from '../../application/use-cases/attandance/ListAttendanceUseCase';
import { UpdateAttendanceUseCase } from '../../application/use-cases/attandance/UpdateAttendanceUseCase';
import { GetMeUseCase } from '../../application/use-cases/auth/GetMeUseCase';

export class AttendanceController {
    constructor(
        private checkInUseCase: CheckInUseCase,
        private checkOutUseCase: CheckOutUseCase,
        private startBreakUseCase: StartBreakUseCase,
        private endBreakUseCase: EndBreakUseCase,
        private listAttendanceUseCase: ListAttendanceUseCase,
        private updateAttendanceUseCase: UpdateAttendanceUseCase,
        private getMeUseCase: GetMeUseCase
    ) {}

    async checkIn(req: Request, res: Response) {
        try {
            const employeeId = req.user!.id;
            const qrPayload =
                typeof req.body?.qrPayload === "string" ? req.body.qrPayload : "";
            const result = await this.checkInUseCase.execute(employeeId, qrPayload);
            const closed = result.checkOutTime != null;
            res.status(closed ? 200 : 201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async checkOut(req: Request, res: Response) {
        try {
            const employeeId = req.user!.id;
            const qrPayload =
                typeof req.body?.qrPayload === "string" ? req.body.qrPayload : "";
            const result = await this.checkOutUseCase.execute(employeeId, qrPayload);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async startBreak(req: Request, res: Response) {
        try {
            const result = await this.startBreakUseCase.execute(req.user!.id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async endBreak(req: Request, res: Response) {
        try {
            const result = await this.endBreakUseCase.execute(req.user!.id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

   async list(req: Request, res: Response) {
        try {
            const filter = {
                tenantId: req.user!.tenantId,
                employeeId: req.query.employeeId as string,
                date: req.query.date as string,
                startDate: req.query.startDate as string,
                endDate: req.query.endDate as string
            };
            const result = await this.listAttendanceUseCase.execute(filter);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const { checkInTime, checkOutTime } = req.body;
            const editedById = req.user!.id;
            const result = await this.updateAttendanceUseCase.execute(id, checkInTime, checkOutTime, editedById);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

async getMe(req: Request, res: Response) {
    try {
        const employeeId = req.user?.id;
        if (!employeeId) return res.status(401).json({ error: 'Yetkisiz.' });
        
        const result = await this.getMeUseCase.execute(employeeId);
        res.status(200).json(result);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }


}




}
