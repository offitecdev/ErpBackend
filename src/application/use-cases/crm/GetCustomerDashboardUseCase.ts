import { ICustomerRepository } from "../../../domain/repositories/ICustomerRepository";

export class GetCustomerDashboardUseCase {
    constructor(private customerRepository: ICustomerRepository) {}

    async execute(customerId: string, tenantId?: string, summaryOnly = false) {
        const dashboard = await this.customerRepository.getCustomerDashboard(customerId, tenantId, summaryOnly);

        if (!dashboard) throw new Error("Müşteri bulunamadı.");

        return dashboard;
    }
}
