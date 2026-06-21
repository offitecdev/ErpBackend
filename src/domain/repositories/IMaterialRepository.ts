import { Material } from "../entities/Material";

export interface IMaterialRepository {
    findById(id: string): Promise<Material | null>;
    
    decrementStock(id: string, quantity: number): Promise<Material>;
    
    createMaterial(tenantId: string, name: string, serialId: string, unitCost: number, initialStock: number, imageUrl?: string | null): Promise<Material>;
}
