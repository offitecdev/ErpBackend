"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXAMPLE_TEMPLATES = exports.EXAMPLE_PRODUCTS = exports.EXAMPLE_GROUPS = exports.EXAMPLE_CATEGORIES = void 0;
exports.EXAMPLE_CATEGORIES = [
    { code: 'MAK', name: 'Makine' },
    { code: 'ELK', name: 'Elektrik' },
];
exports.EXAMPLE_GROUPS = [
    { category: 'MAK', code: 'KMP', name: 'Kompresörler' },
    { category: 'MAK', code: 'ESN', name: 'Eşanjörler' },
    { category: 'MAK', code: 'SGD', name: 'Soğutma devresi elemanları' },
    { category: 'MAK', code: 'FAN', name: 'Fanlar' },
    { category: 'MAK', code: 'SASE', name: 'Şase ve konstrüksiyon' },
    { category: 'ELK', code: 'PLC', name: 'PLC' },
    { category: 'ELK', code: 'HMI', name: 'Operatör panelleri' },
    { category: 'ELK', code: 'SLT', name: 'Şalt malzemeleri' },
    { category: 'ELK', code: 'SRC', name: 'Sürücüler' },
    { category: 'ELK', code: 'SNS', name: 'Sensörler' },
    { category: 'ELK', code: 'KBN', name: 'Pano kabinleri' },
    { category: 'ELK', code: 'KBL', name: 'Kablolar' },
    { category: 'ELK', code: 'AKS', name: 'Pano montaj aksesuarları' },
];
exports.EXAMPLE_PRODUCTS = [
    // ── Makine · Kompresörler
    { key: 'cmp', group: 'KMP', name: 'Yarı hermetik vidalı kompresör', brand: 'Bitzer', modelNumber: 'CSH6553-50Y', serialRequired: true },
    // ── Makine · Eşanjörler
    { key: 'evp', group: 'ESN', name: 'Lehimli plakalı evaporatör', brand: 'Alfa Laval', modelNumber: 'AC232EQ', serialRequired: true },
    { key: 'cnd', group: 'ESN', name: 'Hava soğutmalı kondenser bataryası', brand: 'Friterm', modelNumber: 'FKB-4R-2400' },
    // ── Makine · Soğutma devresi
    { key: 'eev', group: 'SGD', name: 'Elektronik genleşme valfi', brand: 'Danfoss', modelNumber: 'ETS 50C' },
    { key: 'drier', group: 'SGD', name: 'Filtre kurutucu', brand: 'Danfoss', modelNumber: 'DCL 305s' },
    { key: 'sight', group: 'SGD', name: 'Gözetleme camı', brand: 'Danfoss', modelNumber: 'SGP 16s' },
    { key: 'solenoid', group: 'SGD', name: 'Solenoid valf', brand: 'Danfoss', modelNumber: 'EVR 20' },
    { key: 'hp', group: 'SGD', name: 'Yüksek basınç presostatı', brand: 'Danfoss', modelNumber: 'KP 5' },
    { key: 'ball', group: 'SGD', name: 'Küresel vana 1 3/8"', brand: 'Danfoss', modelNumber: 'GBC 35s' },
    // ── Makine · Fanlar
    { key: 'fan', group: 'FAN', name: 'EC aksiyel fan Ø910', brand: 'ebm-papst', modelNumber: 'W3G910-KV12-71' },
    // ── Makine · Şase
    { key: 'frame', group: 'SASE', name: 'Şase ana çerçevesi (galvaniz)', brand: null, modelNumber: 'SAS-AWS20-01' },
    { key: 'panel', group: 'SASE', name: 'Yan kapak paneli RAL 7035', brand: null, modelNumber: 'PNL-AWS20-YAN' },
    { key: 'mount', group: 'SASE', name: 'Kauçuk titreşim takozu M12', brand: null, modelNumber: 'TT-M12-60', minimumOrderQuantity: 20 },
    { key: 'bolt', group: 'SASE', name: 'Paslanmaz cıvata M10×30 (DIN 933 A2)', brand: null, modelNumber: 'DIN933-A2-M10X30', minimumOrderQuantity: 100 },
    // ── Elektrik · PLC
    { key: 'cpu', group: 'PLC', name: 'SIMATIC S7-1200 CPU 1214C DC/DC/DC', brand: 'Siemens', modelNumber: '6ES7214-1AG40-0XB0', serialRequired: true },
    { key: 'ai', group: 'PLC', name: 'SIMATIC S7-1200 SM 1231 analog giriş 8×13 bit', brand: 'Siemens', modelNumber: '6ES7231-4HF32-0XB0' },
    { key: 'dio', group: 'PLC', name: 'SIMATIC S7-1200 SM 1223 16DI/16DO', brand: 'Siemens', modelNumber: '6ES7223-1BL32-0XB0' },
    // ── Elektrik · HMI
    { key: 'hmi', group: 'HMI', name: 'SIMATIC HMI KTP700 Basic 7"', brand: 'Siemens', modelNumber: '6AV2123-2GB03-0AX0', serialRequired: true },
    // ── Elektrik · Şalt
    { key: 'main', group: 'SLT', name: 'Yük ayırıcı ana şalter INS160 3P', brand: 'Schneider Electric', modelNumber: '28908', supplier: 'Schneider Electric' },
    { key: 'contactor', group: 'SLT', name: 'Kontaktör TeSys D 25 A, 24 V DC bobin', brand: 'Schneider Electric', modelNumber: 'LC1D25BD', supplier: 'Schneider Electric' },
    { key: 'mpcb', group: 'SLT', name: 'Motor koruma şalteri GV2 17–23 A', brand: 'Schneider Electric', modelNumber: 'GV2ME21', supplier: 'Schneider Electric' },
    { key: 'mcb', group: 'SLT', name: 'Otomatik sigorta iC60N 1P C10', brand: 'Schneider Electric', modelNumber: 'A9F74110', supplier: 'Schneider Electric' },
    { key: 'psu', group: 'SLT', name: 'Güç kaynağı SITOP PSU6200 24 V / 5 A', brand: 'Siemens', modelNumber: '6EP3333-7SB00-0AX0' },
    // ── Elektrik · Sürücüler
    { key: 'vfd', group: 'SRC', name: 'Frekans invertörü VLT HVAC Drive FC 102, 7,5 kW', brand: 'Danfoss', modelNumber: 'FC-102P7K5T4E20H2', serialRequired: true },
    // ── Elektrik · Sensörler
    { key: 'pt', group: 'SNS', name: 'Basınç transmitteri AKS 32R, −1…12 bar', brand: 'Danfoss', modelNumber: 'AKS 32R' },
    { key: 'ntc', group: 'SNS', name: 'NTC sıcaklık sensörü 10 kΩ, daldırma tip', brand: 'Carel', modelNumber: 'NTC030WP00' },
    // ── Elektrik · Pano kabinleri
    { key: 'enclosure', group: 'KBN', name: 'Kompakt pano AX 600×1000×300 mm', brand: 'Rittal', modelNumber: 'AX 1260.000' },
    // ── Elektrik · Kablolar (metre)
    { key: 'cable5', group: 'KBL', name: 'ÖLFLEX CLASSIC 110 5G2,5 mm²', brand: 'Lapp', modelNumber: '1119305', minimumOrderQuantity: 100 },
    { key: 'cable3', group: 'KBL', name: 'ÖLFLEX CLASSIC 110 3G1,5 mm²', brand: 'Lapp', modelNumber: '1119203', minimumOrderQuantity: 100 },
    { key: 'cable12', group: 'KBL', name: 'ÖLFLEX CLASSIC 110 CY 12G0,75 mm² (ekranlı)', brand: 'Lapp', modelNumber: '1135012', minimumOrderQuantity: 50 },
    { key: 'wire', group: 'KBL', name: 'H07V-K 1,5 mm² kumanda teli, siyah', brand: 'Lapp', modelNumber: '4520001', minimumOrderQuantity: 100 },
    // ── Elektrik · Montaj aksesuarları
    { key: 'duct', group: 'AKS', name: 'Kablo kanalı 60×80 mm, 2 m', brand: 'OBO Bettermann', modelNumber: 'LK4 60080' },
    { key: 'rail', group: 'AKS', name: 'DIN rayı NS 35/7,5 PERF, 2 m', brand: 'Phoenix Contact', modelNumber: '0801733' },
    { key: 'terminal', group: 'AKS', name: 'Vidalı klemens UT 4', brand: 'Phoenix Contact', modelNumber: '3044102', minimumOrderQuantity: 50 },
    { key: 'ferrule', group: 'AKS', name: 'İzoleli kablo yüksüğü AI 1,5-8 RD', brand: 'Phoenix Contact', modelNumber: '3200030', minimumOrderQuantity: 500 },
    { key: 'gland', group: 'AKS', name: 'Kablo rakoru SKINTOP ST-M 25×1,5', brand: 'Lapp', modelNumber: '53111030' },
];
exports.EXAMPLE_TEMPLATES = [
    {
        key: 'chiller-cooling',
        name: 'Chiller · Soğutma devresi',
        category: 'MACHINE',
        mainCard: 'CHILLER',
        codePrefix: 'MAK-COOL',
        description: 'Kompresör, evaporatör, kondenser ve soğutucu akışkan devresinin elemanları.',
        lines: [
            { product: 'cmp', quantity: 2 },
            { product: 'evp', quantity: 1 },
            { product: 'cnd', quantity: 2 },
            { product: 'eev', quantity: 2 },
            { product: 'drier', quantity: 2 },
            { product: 'sight', quantity: 2 },
            { product: 'solenoid', quantity: 2 },
            { product: 'hp', quantity: 2 },
            { product: 'ball', quantity: 4 },
        ],
    },
    {
        key: 'chiller-mechanical',
        name: 'Chiller · Mekanik şase',
        category: 'MACHINE',
        mainCard: 'CHILLER',
        codePrefix: 'MAK-MEK',
        description: 'Şase, kapaklar, fanlar ve bağlantı elemanları.',
        lines: [
            { product: 'frame', quantity: 1 },
            { product: 'panel', quantity: 4 },
            { product: 'fan', quantity: 4 },
            { product: 'mount', quantity: 8 },
            { product: 'bolt', quantity: 120 },
        ],
    },
    {
        key: 'chiller-panel',
        name: 'Chiller · Kumanda panosu',
        category: 'ELECTRICAL',
        mainCard: 'CHILLER',
        codePrefix: 'ELK-PANO',
        description: 'Kumanda panosunun cihazları: PLC, HMI, şalt, sürücüler ve saha sensörleri.',
        lines: [
            { product: 'enclosure', quantity: 1 },
            { product: 'main', quantity: 1 },
            { product: 'cpu', quantity: 1 },
            { product: 'ai', quantity: 1 },
            { product: 'dio', quantity: 1 },
            { product: 'hmi', quantity: 1 },
            { product: 'psu', quantity: 1 },
            { product: 'vfd', quantity: 2 },
            { product: 'contactor', quantity: 4 },
            { product: 'mpcb', quantity: 4 },
            { product: 'mcb', quantity: 6 },
            { product: 'pt', quantity: 4 },
            { product: 'ntc', quantity: 6 },
        ],
    },
    {
        key: 'chiller-panel-assembly',
        name: 'Chiller · Pano montajı',
        category: 'ELECTRICAL',
        mainCard: 'CHILLER',
        codePrefix: 'ELK-PANO-MONTAJ',
        description: 'Pano içi ve saha kablolaması, kanal, ray, klemens ve sarf malzemeleri.',
        lines: [
            { product: 'cable5', quantity: 60, unit: 'M' },
            { product: 'cable3', quantity: 40, unit: 'M' },
            { product: 'cable12', quantity: 30, unit: 'M' },
            { product: 'wire', quantity: 150, unit: 'M' },
            { product: 'duct', quantity: 6 },
            { product: 'rail', quantity: 3 },
            { product: 'terminal', quantity: 60 },
            { product: 'ferrule', quantity: 400 },
            { product: 'gland', quantity: 16 },
        ],
    },
];
//# sourceMappingURL=bomExamples.js.map