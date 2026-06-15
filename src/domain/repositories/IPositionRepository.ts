import{Position} from "../entities/Position";
import {CalculationItem} from "../entities/CalculationItem";

export interface IPositionRepository{
    createMany(positions: Partial<Position>[]): Promise<void>;
    findById(positionId: string, options?: { includeImages?: boolean }): Promise<any | null>;
    findByTenderId(tenderId:string, options?: { includeImages?: boolean }): Promise<any[]>;
    saveCalculation(calculationItem: Partial<CalculationItem>): Promise<CalculationItem>;
    getCalculationByPositionId(positionId:string): Promise<CalculationItem | null>;
    deletePosition(positionId: string): Promise<void>;
    updatePosition(positionId: string, patch: {
        shortDescription?: string;
        longDescription?: string | null;
        quantity?: number;
        unit?: string | null;
        unitPrice?: number | null;
        discount?: number | null;
        taxRate?: number | null;
        imageUrl?: string | null;
        npkCode?: string | null;
        rowType?: string;
        sourceArticleId?: string | null;
        displayOrder?: number;
    }): Promise<any>;
}
