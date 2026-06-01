import {Request , Response} from "express";
import {LoginUseCase} from "../../application/use-cases/auth/LoginUseCase";
import { GetUserPermissionsUseCase } from "../../application/use-cases/auth/GetUserPermissionsUseCase";
import { GetMeUseCase } from "../../application/use-cases/auth/GetMeUseCase";

export class AuthController {
    constructor(
        private loginUseCase: LoginUseCase,
        private getUserPermissionsUseCase: GetUserPermissionsUseCase,
        private getMeUseCase: GetMeUseCase
    ){}

    async login(req:Request , res:Response){
        try{
            const {email,password} = req.body;
            const result = await this.loginUseCase.execute(email,password);
            res.status(200).json(result);
        }catch(error:any){
            res.status(400).json({error:error.message});
        }
    }

    async getPermissions(req:Request , res:Response){
        try{
            const employeeId = req.user?.id;
            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const permissions = await this.getUserPermissionsUseCase.execute(employeeId);
            res.status(200).json({ permissions });
        }catch(error:any){
            res.status(500).json({error: error.message});
        }
    }

    async getMe(req:Request , res:Response){
        try{
            const employeId = req.user?.id;

            if(!employeId){
                return res.status(401).json({error:'Yetkisiz erişim.'});
            }

            const employee = await this.getMeUseCase.execute(employeId);
            return res.status(200).json(employee);

        }catch(error : any){
            res.status(500).json({error: error.message});
        }
}
}
