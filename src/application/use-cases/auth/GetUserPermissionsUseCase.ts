import { IRoleRepository } from "../../../domain/repositories/IRoleRepository";

export class GetUserPermissionsUseCase {
    constructor(private roleRepository: IRoleRepository) {}

    async execute(employeeId: string): Promise<string[]> {
        return await this.roleRepository.getEmployeePermissions(employeeId);
    }


}