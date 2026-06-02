"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DummyTenderParserService = void 0;
class DummyTenderParserService {
    async parseAndValidate(xmlContent, format) {
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
exports.DummyTenderParserService = DummyTenderParserService;
//# sourceMappingURL=DummyTenderParserService.js.map