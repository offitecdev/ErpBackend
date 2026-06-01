import {Request,Response} from 'express';
import {CreateLeaveRequestUseCase } from '../../application/use-cases/leave/CreateLeaveRequestUseCase';
import { ApproveLeaveRequestUseCase } from '../../application/use-cases/leave/ApproveLeaveRequestUseCase';
import { ListLeavesUseCase } from '../../application/use-cases/leave/ListLeavesUseCase';

export class LeaveController{
    constructor(
        private createLeaveRequestUseCase : CreateLeaveRequestUseCase,
        private approveLeaveRequestUseCase : ApproveLeaveRequestUseCase,
        private listLeavesUseCase: ListLeavesUseCase
    ){}

    async createLeaveRequest(req:Request,res:Response){
        try{
            const {employeeId,leaveTypeId,startDate,endDate,description} = req.body;

            const leaveRequest = await this.createLeaveRequestUseCase.execute({
                employeeId,
                leaveTypeId,  
                startDate,
                endDate,
                description
            });

            res.status(201).json(leaveRequest);

        }catch(error:any){
            res.status(400).json({error : error.message});
        }
    }

    async evaluateLeaveRequest(req:Request,res:Response){
        try{
            const {id} = req.params as {id: string};
            const {isapproved,managerId} = req.body;

            const result = await this.approveLeaveRequestUseCase.execute(id,managerId,isapproved);
            res.status(200).json(result);
        }catch(error:any){
            res.status(400).json({error : error.message});
        }
    }

    async list(req: Request, res: Response) {
        try {
            const filter: { tenantId?: string; employeeId?: string; status?: string } = {};
            if (req.user?.tenantId) filter.tenantId = req.user.tenantId;
            if (req.query.all !== 'true' && req.user?.id) filter.employeeId = req.user.id;
            if (req.query.status) filter.status = req.query.status as string;

            const results = await this.listLeavesUseCase.execute(filter);
            res.status(200).json(results);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}