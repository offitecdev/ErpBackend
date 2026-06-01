export interface ParsedPositionData {
    refId: string;
    parentRefId?: string;
    positionNumber: string;
    shortDescription: string;
    longDescription?: string;
    hierarchyLevel: number;
    quantity: number;
    unit?: string | null;
    npkCode?: string | null;

}

export interface ParsedTenderData{
    tenderNumber : string ;
    format : 'SIA451' | 'CRBX';
    positions : ParsedPositionData[];
}

export interface ITenderParserService{
    parseAndValidate(xmlContent: string , format: 'SIA451' | 'CRBX'): Promise<ParsedTenderData>;
}