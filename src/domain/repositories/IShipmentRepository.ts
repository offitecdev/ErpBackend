
import { Shipment } from "../entities/Logistics";

export interface IShipmentFilter {
    tenantId: string;
    customerId?: string;
    projectId?: string;
    status?: string;
    search?: string;
    isEtaPassed?: boolean;
}

export interface IShipmentRepository {
    create(data: Partial<Shipment>): Promise<Shipment>;
    update(id: string, data: Partial<Shipment>): Promise<Shipment>;
    markManyDelayed(ids: string[]): Promise<number>;
    findById(id: string): Promise<Shipment | null>;
    findAll(filter: IShipmentFilter): Promise<Shipment[]>;
    delete(id: string): Promise<void>;
    
    findByDocumentNumber(tenantId: string, docType: 'foNumber' | 'cmrNumber' | 'awNumber', number: string, excludeId?: string): Promise<Shipment | null>;
}