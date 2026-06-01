export class CalculationItem {
    constructor(
        public id: string,
        public positionId: string,
        public materialCost: number,
        public laborCost: number,
        public overheadCost: number,
        public riskAmount: number,
        public additionalCost: number,
        public profitMargin: number,
        public totalCalculatedPrice: number
    ){}

}