
import { ITenderParserService, ParsedTenderData } from "../../application/interfaces/ITenderParserService";

export class DummyTenderParserService implements ITenderParserService {
    async parseAndValidate(xmlContent: string, format: 'SIA451' | 'CRBX'): Promise<ParsedTenderData> {

        if (!xmlContent || !xmlContent.includes("<tender>")) {
            throw new Error(`[BLOCKED] Geçersiz ${format} formatı. Şema doğrulama (Schema Validation) başarısız.`);
        }

        return {
            tenderNumber: `TND-${Math.floor(Math.random() * 10000)}`,
            format: format,
            positions: [
                {
                    refId: "ref-1",
                    positionNumber: "100",
                    shortDescription: "Hazırlık İşleri (Bölüm)",
                    hierarchyLevel: 0,
                    quantity: 1,
                    npkCode: "111.000"
                },
                {
                    refId: "ref-2",
                    parentRefId: "ref-1",
                    positionNumber: "100.1",
                    shortDescription: "Şantiye Kurulumu (Alt Pozisyon)",
                    hierarchyLevel: 1,
                    quantity: 1,
                    npkCode: "111.100"
                },
                {
                    refId: "ref-3",
                    parentRefId: "ref-2",
                    positionNumber: "100.1.1",
                    shortDescription: "Konteyner Temini (Detay)",
                    hierarchyLevel: 2,
                    quantity: 2,
                    unit: "Adet",
                    npkCode: "111.110"
                }
            ]
        };
    }
}