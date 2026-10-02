/**
 * ── OCC «ÜRETİM, TEST VE SEVKİYAT KONTROL STANDARDI» ALS DATEN (02.10.2026) ──
 *
 * Quelle: C:\ERP\OCC_Uretim_Test_Sevkiyat_Standardi_TR-1.pdf — Chiller (S. 2), Dry Cooler (S. 3),
 * Isı Pompası (S. 4), Makine Panosu (S. 5 = der Bereich Elektrik aller drei), Final QC (S. 7 B·1),
 * die Stufe «Sevkiyat» (S. 7) und der Makine dosyası (S. 6 §4).
 * Gelesen von `seed-occ-production-templates.ts` (Vorlagen, Unteraufgaben) und
 * `seed-occ-shipping-stage.ts` (die Stufe Sevkiyat vor dem Final, 02.10.2026 abends). Flags:
 * D = Doküman, O = Onay, F = Fotoğraf yeterli, U = Ücret girilsin (Betrag in CHF), K = Kilit
 * (erst wenn alle Schritte davor erledigt sind). Die Standards gehen als FREIER TEXT an die KI
 * (eine Zeile = eine Anforderung); Zahlen erfindet hier niemand — «proje/üretici onaylı değer»
 * trägt die Verwaltung am Gerät ein.
 */
import type { ProductionBuiltInArea, ProductionBuiltInStage } from '../src/domain/entities/ProductionTask';

export interface OccSeedSubtask {
    name: string;
    /** «DOF», «DO», «O», «DOFU», «OK» … */
    flags: string;
    /** Freier Text, Zeilen = Anforderungen; null ohne «Doküman». */
    standards: string | null;
    checklist: string[];
}

export interface OccSeedTask {
    area: ProductionBuiltInArea;
    stage: ProductionBuiltInStage;
    code: string;
    name: string;
    /** Gewicht in der STUFE (%), nur für neue Vorlagen. */
    weight: number;
    subtasks: OccSeedSubtask[];
}

export interface OccSeedTemplate {
    name: string;
    /** false: die Vorlage muss es schon geben (Chiller) — sie wird nie neu angelegt. */
    create: boolean;
    /** Gewicht der Stufen je Bereich (%), nur für neue Vorlagen. */
    stageWeights: Record<ProductionBuiltInArea, Partial<Record<ProductionBuiltInStage, number>>>;
    tasks: OccSeedTask[];
}

/* ── Gemeinsame Zeilen der Standards (Abschnitt 4.8) ───────────────────────── */

const ORTAK_MONTAJ = [
    'Fotoğraflarda neyin çekildiği anlaşılır; görünmeyecek işler kapanmadan çekilmiş ve net.',
    'Kısa notta yapılan iş yazılı; varsa sapma, kullanılan malzeme, çizim/BOM değiştiyse revizyon numarası yazılı.',
    // PDF s. 6 §4 «kullanılan kritik parçalar ve seri numaraları» (02.10.2026 abends).
    'Kritik parça (kompresör, pompa, fan, sürücü, PLC vb.) takıldıysa seri numarası kısa notta yazılı.',
];
const ORTAK_TEST = [
    'Fotoğraflarda ölçüm cihazı ya da ekran değeri okunur.',
    'Kısa notta (ya da eklenen belgede) her ölçüm için hedef/limit, ölçülen değer ve PASS/FAIL yazılı.',
    'Ölçülen değer proje/üretici onaylı aralıkta.',
    'FAIL varsa düzeltme ve tekrar test notta yazılı.',
];

type Kind = 'montaj' | 'test';
const lines = (kind: Kind, special: string, device?: { name: string; text: string }): string => [
    ...(kind === 'montaj' ? ORTAK_MONTAJ : ORTAK_TEST),
    `Bu alt göreve özel: ${special}`,
    ...(device ? [`Cihaza özel (${device.name}): ${device.text}`] : []),
].join('\n');

const sub = (name: string, flags: string, standards: string | null, checklist: string[]): OccSeedSubtask => ({ name, flags, standards, checklist });

/** «Ara kontrol» (yalnız Onay) — Chiller M-11'deki liste, Dry Cooler M-08 ve Isı Pompası M-09'da aynı. */
const araKontrol = (): OccSeedSubtask => sub('Ara kontrol', 'O', null, [
    'Çizim (son revizyon) ile karşılaştırıldı',
    'BOM plan/gerçek karşılaştırıldı',
    'Görünmeyecek işlerin fotoğrafları var',
    'Servis erişimi ve sabitlemeler kontrol edildi',
    'Açık hata yok',
]);

/* ── Elektrik (PDF s. 5 «Makine Panosu») — üç cihazda aynı, CİHAZA ÖZEL ayrı ── */

interface ElectricalSpecial { e09?: string; e13?: string; e14?: string }

const electricalTasks = (device: string, special: ElectricalSpecial): OccSeedTask[] => {
    const deviceLine = (text: string | undefined) => (text ? { name: device, text } : undefined);
    const task = (stage: ProductionBuiltInStage, code: string, name: string, weight: number, subtasks: OccSeedSubtask[] = []): OccSeedTask =>
        ({ area: 'ELECTRICAL', stage, code, name, weight, subtasks });
    return [
        task('circuit', 'E-01', 'Elektrik yüklerini belirleme', 12),
        task('circuit', 'E-02', 'Güç ve koruma tasarımı', 23),
        task('circuit', 'E-03', 'Elektrik şemaları', 29),
        task('circuit', 'E-04', 'Pano yerleşimi', 14),
        task('circuit', 'E-05', 'Kontrol mimarisi', 22),
        task('bom', 'E-06', 'Elektrik BOM ve dokümanları', 100),
        task('panel', 'E-07', 'Pano montajı', 21, [
            sub('Pano yerleşim kontrolü', 'DOF', lines('montaj', 'pano, DIN raylar, kanallar, komponentlerin ilk yerleşimi.'), [
                'Pano, DIN raylar ve kanallar yerinde',
                'Komponentler elektrik şemasına göre yerleşik',
                'İlk yerleşim fotoğrafı var',
            ]),
        ]),
        task('panel', 'E-08', 'Pano içi kablolama', 26, [
            sub('Güç devresi kontrolü', 'DOF', lines('montaj', 'ana besleme, sigorta/şalter, kontaktör, motor/fan/pompa/kompresör çıkışları; kesit ve terminaller.'), [
                'Ana besleme, sigorta/şalter ve kontaktörler bağlı',
                'Çıkışlar bağlı',
                'Kesitler şemaya uygun',
                'Terminaller kontrol edildi',
            ]),
        ]),
        task('panel', 'E-09', 'Cihaz içi kablolama', 26, [
            sub('Cihaz içi kablolama kontrolü', 'DOF', lines('montaj', 'kapak kapanmadan kablolama.', deviceLine(special.e09)), [
                'Güç ve kumanda kabloları çekildi',
                'PE bağlantıları yapıldı',
                'Saha terminalleri bağlı',
                'Kablo ve terminal etiketleri tamam',
                'Kapak kapanmadan fotoğraf çekildi',
            ]),
        ]),
        task('panel', 'E-10', 'Sensör ve kumanda bağlantıları', 16, [
            sub('Kumanda ve I/O kontrolü', 'DOF', lines('montaj', 'sensör, giriş/çıkış, röle, 0-10 V, haberleşme, saha terminalleri; kanal kapağı kapanmadan.'), [
                'Sensörler bağlı',
                'Giriş/çıkış, röle ve 0-10 V bağlı',
                'Haberleşme bağlı',
                'Kanal kapağı kapanmadan fotoğraf çekildi',
            ]),
        ]),
        task('panel', 'E-11', 'Koruyucu iletken bağlantıları', 11, [
            sub('PE ve etiketleme kontrolü', 'DOF', lines('montaj', 'koruma iletkeni, terminal/kablo numaraları, komponent etiketleri, klemens düzeni.'), [
                'Koruma iletkeni bütün gövdelere bağlı',
                'Numaralar tamam',
                'Komponent etiketleri tamam',
                'Klemens düzeni şemaya uygun',
            ]),
        ]),
        task('test', 'E-12', 'Yazılım ve parametre yükleme', 50, [
            sub('PLC/HMI ve haberleşme testi', 'DOF', lines('test', 'yazılım versiyonu, parametreler/set değerleri, ekran, projedeki Modbus/BACnet/diğer haberleşme.'), [
                'Program yüklendi, versiyon yazılı',
                'Parametreler ve set değerleri girildi',
                'Ekran kontrol edildi',
                'Haberleşme test edildi',
            ]),
        ]),
        task('test', 'E-13', 'Giriş-çıkış doğrulama', 25, [
            sub('I/O testi', 'DOF', lines('test', 'giriş ve çıkışlar tek tek; her biri için beklenen ve sonuç.', deviceLine(special.e13)), [
                'Girişler tek tek test edildi',
                'Çıkışlar tek tek test edildi',
                'Sonuçlar yazılı',
                'Hatalı I/O yok ya da düzeltilip tekrar test edildi',
            ]),
        ]),
        task('test', 'E-14', 'Elektriksel testler', 25, [
            sub('Elektrik ve safety testi', 'DOF', lines('test', 'şema ile görsel kontrol, PE/süreklilik, izolasyon, gerilim/faz sırası, korumalar, ana devre, emniyet zinciri/acil stop/alarm/interlock.', deviceLine(special.e14)), [
                'Şema ile görsel kontrol yapıldı',
                'PE/süreklilik ölçüldü',
                'İzolasyon ölçüldü',
                'Gerilim ve faz sırası kontrol edildi',
                'Korumalar ve ana devre çalışıyor',
                'Akım değerleri yazılı',
                'Emniyet zinciri, acil stop, alarm, interlock çalışıyor',
            ]),
        ]),
        task('final', 'E-15', 'Son durum dokümanları ve yedekleme', 100, [
            // F yok — burada belge gerekir.
            sub('Son durum dokümanları', 'DO', 'Güncel elektrik şeması (son revizyon), PLC/HMI yedeği ve versiyonu, test sonuçları, seri no/QR, teknik dokümanlar.', [
                'Güncel şema dosyada',
                'PLC/HMI yedeği alındı',
                'Test sonuçları dosyada',
                'Seri no ve QR doğru',
                'Teknik dokümanlar tamam',
            ]),
        ]),
    ];
};

/** Elektrik aşama ağırlıkları — üç cihazda aynı. */
const ELECTRICAL_STAGES: Partial<Record<ProductionBuiltInStage, number>> = { circuit: 30, approval: 0, bom: 5, panel: 35, test: 25, final: 5 };

/* ── Final QC (PDF s. 7 «Test › Final QC › Sevkiyat Hazırlığı») — üç cihazda aynı ──────────
 * Seit dem 02.10.2026 abends steht die Aufgabe in der Stufe «Sevkiyat» (vor dem Final) — das
 * verschiebt `seed-occ-shipping-stage.ts`; die Sevkiyat-Unteraufgaben stehen unten (OCC_SHIPPING_*). */

const finalAndShipping = (device: string, finalQc: string): OccSeedSubtask[] => [
    sub('Final montaj ve görsel QC', 'DOF', [
        ...ORTAK_MONTAJ,
        `Cihaza özel (${device}): ${finalQc}`,
        'Fotoğraflarda cihazın en az 4 yönü (ön, arka, sağ, sol) var; seri no ve QR okunur.',
    ].join('\n'), [
        'Final montaj tamam',
        'Çizim/BOM ile son karşılaştırma yapıldı',
        'Servis alanı ve temizlik tamam',
        'Seri no ve QR doğru',
        'En az 4 yön fotoğrafı var',
    ]),
];

/* ── Stufe «Sevkiyat» (PDF s. 7) — Mekanik yolu: … › Test › Sevkiyat › Final (bayrak) ─────────
 * 02.10.2026 abends, Samet: «sevkiyat adımını eklemek istiyorum … bir ücretin de girilmesi
 * gerekiyordu … sevkiyatla finale gelmesi gerekiyor». Eine EIGENE Stufe (wie «Yeni aşama») im
 * festen Bereich Mekanik, direkt vor dem Final. Darin: die Final-QC-Aufgabe (verschoben) und die
 * vier Schritte des PDF; ins Final kommt der Makine dosyası (S. 6 §4) mit dem Sevkiyat raporu. */

export interface OccShippingTask {
    name: string;
    /** Gewicht in der Stufe (%), nur beim Anlegen. */
    weight: number;
    subtask: OccSeedSubtask;
}

export const OCC_SHIPPING_STAGE = { key: 'g-sevkiyat', name: 'Sevkiyat' } as const;

/** Die Final-QC-Aufgabe in der Stufe Sevkiyat: ihr Gewicht dort und ihr Name (vorher «… ve sevkiyat»). */
export const OCC_FINAL_QC = {
    subtaskName: 'Final montaj ve görsel QC',
    weight: 20,
    oldName: 'Final montaj, QC ve sevkiyat',
    newName: 'Final montaj ve QC',
} as const;

export const OCC_SHIPPING_TASKS: readonly OccShippingTask[] = [
    {
        name: 'Nakliye planı',
        weight: 15,
        // PDF s. 7 A: nakliyeci önceden tanımlı — teklif/fiyat (Ücret alanı), araç, tarihler, iletişim.
        subtask: sub('Nakliye planı ve ücret', 'DOFU', [
            'Teklif belgesi ya da fotoğrafı eklenmiş.',
            '«Ücret (CHF)» alanındaki tutar teklifteki tutarla aynı.',
            'Kısa notta: nakliyeci, araç tipi, planlanan yükleme tarihi, tahmini teslim tarihi, iletişim bilgisi.',
            'Plan üretim bitmeden yapılır; final adımında nakliyeci aranmaya başlanmaz.',
        ].join('\n'), [
            'Nakliyeci seçildi',
            'Nakliye ücreti (CHF) girildi ve teklifle aynı',
            'Araç tipi uygun',
            'Yükleme ve teslim tarihi projeye uygun',
            'İletişim bilgisi var',
        ]),
    },
    {
        name: 'Sevkiyat hazırlığı',
        weight: 30,
        // PDF s. 7 B·1–B·5.
        subtask: sub('Sevkiyat hazırlığı', 'DOF', 'Fotoğraflar: final görsel kontrol, bağlantı korumaları, darbe/köşe koruması, folyo ve sabitleme, etiketli aksesuar ve dokümanlar.', [
            'Hasar, gevşek parça, kapak, etiket, seri no, QR kontrol edildi',
            'Bağlantılar korundu',
            'Darbe ve köşe koruması yapıldı',
            'Folyo; hareketli parçalar ve kapaklar sabitlendi',
            'Aksesuar ve dokümanlar etiketli hazır',
        ]),
    },
    {
        name: 'Sevke hazır onayı',
        weight: 10,
        // PDF s. 7 C «sistem kilidi»: Onay + Kilit — öncesi bitmeden onaylanamaz.
        subtask: sub('Sevke hazır onayı', 'OK', null, [
            'Montaj adımları tamamlandı',
            'Zorunlu testlerin tamamı PASS',
            'Ölçülen değerler onaylı aralıkta',
            'Açık hata/blocker yok',
            'Fotoğraf, teknik doküman, seri no ve QR tamam',
            'Nakliyeci, sevkiyat planı ve nakliye ücreti onaylı',
        ]),
    },
    {
        name: 'Yükleme ve sevkiyat',
        weight: 25,
        // PDF s. 7 B·6 — «Gönderildi» de kilitli.
        subtask: sub('Yükleme ve sevkiyat', 'DOFK', [
            'Fotoğraflar: yükleme öncesi, araç içi sabitleme, yükleme sonrası.',
            'Kısa notta sevkiyat bilgisi: araç/plaka, çıkış tarihi ve saati.',
        ].join('\n'), [
            'Yükleme öncesi fotoğraf var',
            'Araçta sabitleme yapıldı',
            'Yükleme sonrası fotoğraf var',
            'Sevkiyat bilgisi yazılı',
        ]),
    },
];

/** Das Final (die Fahne): der Makine dosyası und der Sevkiyat raporu (PDF s. 6 §4, s. 7 B·6). */
export const OCC_MACHINE_FILE_TASK: OccShippingTask = {
    name: 'Sevkiyat raporu ve makine dosyası',
    weight: 100,
    subtask: sub('Sevkiyat raporu ve makine dosyası', 'DOFK', [
        'Sevkiyat raporu ya da imzalı teslim belgesi eklenmiş (belge veya fotoğraf).',
        'Kısa notta: gönderim tarihi, teslim alan kişi, varsa hasar/eksik notu.',
        'Makine dosyası tek yerde tamam: güncel çizimler ve revizyonlar, BOM plan/gerçek, kullanılan kritik parçalar ve seri numaraları, montaj fotoğrafları, test raporları, Offitec seri no/QR, teknik dokümanlar.',
        'Tamamlanmış rapor ve fotoğraf silinmez; hata varsa yeni düzeltme/revizyon kaydı vardır.',
    ].join('\n'), [
        'Güncel çizimler ve revizyonlar dosyada',
        'BOM plan/gerçek dosyada',
        'Kritik parçaların seri numaraları yazılı',
        'Montaj fotoğrafları ve test raporları dosyada',
        'Seri no, QR ve teknik dokümanlar tamam',
        'Sevkiyat raporu / teslim belgesi eklendi',
    ]),
};

/* ── Ortak mekanik alt görevler ─────────────────────────────────────────── */

const fanGrubu = (): OccSeedSubtask => sub('Fan grubu kontrolü', 'DOF', lines('montaj', 'fanlar, koruyucular, motor/EC bağlantıları, montaj yönü, sabitleme.'), [
    'Fanlar ve koruyucular takılı',
    'Motor/EC bağlı',
    'Montaj yönü doğru',
    'Sabitleme tamam',
]);
const basincTesti = (name: string, special: string, checklist: string[]): OccSeedSubtask => sub(name, 'DOF', lines('test', special), checklist);
const suDevresi = (): OccSeedSubtask => sub('Su devresi testi', 'DOF', lines('test', 'sızdırmazlık, pompa yönü, flow switch, mümkünse debi.'), [
    'Sızdırmazlık PASS',
    'Pompa yönü doğru',
    'Flow switch çalışıyor',
    'Debi ölçüldü (mümkünse)',
]);
const vakumSarj = (): OccSeedSubtask => sub('Vakum ve şarj', 'DOF', lines('test', 'vakum sonucu, akışkan tipi, doldurulan miktar.'), [
    'Vakum değeri hedefte',
    'Akışkan tipi doğru',
    'Miktar hedefte',
]);

const mech = (stage: ProductionBuiltInStage, code: string, name: string, weight: number, subtasks: OccSeedSubtask[] = []): OccSeedTask =>
    ({ area: 'MECHANICAL', stage, code, name, weight, subtasks });

/* ── Chiller (PDF s. 2) — MEVCUT şablon: yalnız alt görevler eklenir ───────── */

const CHILLER: OccSeedTemplate = {
    name: 'Chiller',
    create: false,
    // Mevcut şablonun ağırlıkları aynen kalır — burada yalnız bilgi.
    stageWeights: { MECHANICAL: {}, ELECTRICAL: {} },
    tasks: [
        mech('production', 'M-07', 'Şase ve sac imalatı', 0, [
            sub('Şase kontrolü', 'DOF', lines('montaj', 'şase/gövde genel yerleşim.'), [
                'Şase/gövde çizime uygun',
                'Sabitleme noktaları hazır',
                'Hasar yok',
                'Servis erişimi uygun',
            ]),
        ]),
        mech('production', 'M-08', 'Ana ekipman montajı', 0, [
            sub('Ana komponent kontrolü', 'DOF', lines('montaj', 'kompresör, eşanjörler, pompa/fan, projeye özel parçalar; pozisyon, sabitleme, servis erişimi.'), [
                'Ana parçalar yerinde',
                'Pozisyonlar çizime uygun',
                'Sabitlemeler tamam',
                'Servis erişimi kontrol edildi',
            ]),
        ]),
        mech('production', 'M-09', 'Soğutucu akışkan borulaması', 0, [
            sub('Borulama kontrolü', 'DOF', lines('montaj', 'izolasyon kapanmadan borular, kaynaklar, vana/filtre/EEV, sensörler, servis bağlantıları, destekler.'), [
                'Borular, vana/filtre/EEV ve sensörler takılı',
                'Servis bağlantıları erişilebilir',
                'Kaynaklar tamam',
                'Destekler tamam',
                'İzolasyon kapanmadan fotoğraflar çekildi',
            ]),
        ]),
        mech('production', 'M-10', 'Hidrolik grup montajı', 0, [
            sub('Hidrolik kontrolü', 'DOF', lines('montaj', 'izolasyon öncesi su bağlantıları, pompa, vana, sensör, flow switch, tahliye/hava alma, akış yönü.'), [
                'Bağlantılar, pompa, vana, sensörler takılı',
                'Flow switch doğru yönde',
                'Tahliye ve hava alma var',
                'Akış yönü doğru',
                'İzolasyon öncesi fotoğraflar çekildi',
            ]),
        ]),
        mech('production', 'M-11', 'Fan grubu montajı', 0, [fanGrubu(), araKontrol()]),
        mech('test', 'M-12', 'Basınç ve sızdırmazlık kontrolleri', 0, [
            basincTesti('Soğutma devresi basınç testi', 'test basıncı, süre, sonuç, varsa kaçak noktası.', [
                'Basınç ve süre yazılı',
                'Düşüş onaylı limitte',
                'Kaçak yok ya da yeri ve düzeltmesi yazılı',
                'Sonuç PASS',
            ]),
            suDevresi(),
        ]),
        mech('test', 'M-13', 'Vakum ve akışkan şarjı', 0, [
            vakumSarj(),
            sub('Test çalışması', 'DOF', lines('test', 'giriş/çıkış sıcaklıkları, ΔT, basınçlar, kompresör/fan/pompa akımları, set değere ulaşma.'), [
                'Sıcaklıklar ve ΔT yazılı',
                'Basınçlar yazılı',
                'Akımlar yazılı',
                'Set değere ulaşıldı',
            ]),
        ]),
        mech('final', 'M-14', 'İzolasyon ve son mekanik kontrol', 0,
            finalAndShipping('Chiller', 'izolasyon, kapaklar, etiketler, bağlantı ağızları, servis alanı, temizlik.')),
        ...electricalTasks('Chiller', {
            e09: 'makine içi güç/kumanda kabloları ve sensörler.',
            e14: 'kompresör/fan/pompa akımları, kritik alarm ve emniyet fonksiyonları.',
        }),
    ],
};

/* ── Dry Cooler (PDF s. 3) — YENİ şablon ─────────────────────────────────── */

const DRY_COOLER: OccSeedTemplate = {
    name: 'Dry Cooler',
    create: true,
    stageWeights: {
        MECHANICAL: { equipment: 15, drawing: 10, approval: 0, bom: 5, production: 35, test: 25, final: 10 },
        ELECTRICAL: ELECTRICAL_STAGES,
    },
    tasks: [
        mech('equipment', 'M-01', 'Çalışma şartlarını belirleme', 30),
        mech('equipment', 'M-02', 'Eşanjör ve fan seçimi', 40),
        mech('equipment', 'M-03', 'Hidrolik bağlantı tasarımı', 30),
        mech('drawing', 'M-04', 'Şase ve gövde tasarımı', 100),
        mech('bom', 'M-05', 'Teknik dokümantasyon ve mekanik BOM', 100),
        mech('production', 'M-06', 'Şase ve eşanjör', 35, [
            sub('Şase ve eşanjör kontrolü', 'DOF', lines('montaj', 'şase/gövde, eşanjör bataryası, sabitleme, hasar, kolektör yönü, servis erişimi.'), [
                'Batarya sabitlendi',
                'Hasar yok',
                'Kolektör yönü doğru',
                'Servis erişimi uygun',
            ]),
        ]),
        mech('production', 'M-07', 'Fan grubu', 35, [fanGrubu()]),
        mech('production', 'M-08', 'Hidrolik bağlantılar', 30, [
            sub('Hidrolik bağlantı kontrolü', 'DOF', lines('montaj', 'kolektörler, giriş/çıkış, tahliye/hava alma, sensör/opsiyonel vana, destekler; bağlantılar kapanmadan.'), [
                'Kolektörler ve giriş/çıkış bağlı',
                'Tahliye ve hava alma var',
                'Sensör/vana takılı',
                'Destekler tamam',
            ]),
            araKontrol(),
        ]),
        mech('test', 'M-09', 'Eşanjör basınç testi', 40, [
            basincTesti('Eşanjör basınç testi', 'test basıncı, süre, sonuç.', ['Basınç ve süre yazılı', 'Düşüş onaylı limitte', 'Sonuç PASS']),
        ]),
        mech('test', 'M-10', 'Fan yönü ve regülasyon', 35, [
            sub('Fan yönü ve regülasyon testi', 'DOF', lines('test', 'tüm fanların yönü ve çalışması; kademe/0-10 V/EC kontrolü projeye göre; komut ve tepki.'), [
                'Tüm fanların yönü doğru',
                'Fanlar çalışıyor',
                'Regülasyon komutu ve tepkisi yazılı',
            ]),
        ]),
        mech('test', 'M-11', 'Final çalışma', 25, [
            sub('Final çalışma ve görsel QC', 'DOF', lines('test', 'anormal titreşim/ses, fan çalışması, hasar.'), [
                'Anormal titreşim/ses yok',
                'Fanlar normal çalışıyor',
                'Hasar yok',
            ]),
        ]),
        mech('final', 'M-12', 'Final montaj ve QC', 100,
            finalAndShipping('Dry Cooler', 'kapaklar, koruma elemanları, etiketler, taşıma noktaları, temizlik, çizim/BOM final kontrolü.')),
        ...electricalTasks('Dry Cooler', {
            e09: 'besleme, fan kumandası, kontrolör.',
            e13: 'sıcaklık/basınç sensörleri ve varsa Modbus/BMS.',
            e14: 'fan akımları ve koruma elemanları.',
        }),
    ],
};

/* ── Isı Pompası (PDF s. 4) — YENİ şablon ────────────────────────────────── */

const HEAT_PUMP: OccSeedTemplate = {
    name: 'Isı Pompası',
    create: true,
    stageWeights: {
        MECHANICAL: { equipment: 20, drawing: 8, approval: 0, bom: 5, production: 32, test: 25, final: 10 },
        ELECTRICAL: ELECTRICAL_STAGES,
    },
    tasks: [
        mech('equipment', 'M-01', 'Çalışma şartlarını belirleme', 20),
        mech('equipment', 'M-02', 'Ana ekipman seçimi', 30),
        mech('equipment', 'M-03', 'Soğutma devresi tasarımı', 30),
        mech('equipment', 'M-04', 'Hidrolik devre tasarımı', 20),
        mech('drawing', 'M-05', 'Şase ve gövde tasarımı', 100),
        mech('bom', 'M-06', 'Teknik dokümantasyon ve mekanik BOM', 100),
        mech('production', 'M-07', 'Şase ve ana komponentler', 30, [
            sub('Ana komponent kontrolü', 'DOF', lines('montaj', 'şase/gövde, kompresör, eşanjörler, fan/pompa, projeye özel parçalar; pozisyon ve sabitleme.'), [
                'Ana parçalar yerinde',
                'Pozisyonlar çizime uygun',
                'Sabitlemeler tamam',
            ]),
        ]),
        mech('production', 'M-08', 'Soğutma devresi', 40, [
            sub('Soğutma devresi kontrolü', 'DOF', lines('montaj', 'izolasyon öncesi borulama, 4-yollu vana (varsa), EEV, filtre, sensörler, servis bağlantıları, kaynaklar.'), [
                'Borulama tamam',
                '4-yollu vana (varsa), EEV, filtre takılı',
                'Sensörler ve servis bağlantıları tamam',
                'Kaynaklar kontrol edildi',
            ]),
        ]),
        mech('production', 'M-09', 'Hidrolik devre', 30, [
            sub('Hidrolik kontrolü', 'DOF', lines('montaj', 'izolasyon öncesi pompa, vana, flow switch, sensör, emniyet/tahliye/hava alma, akış yönü.'), [
                'Pompa, vana, sensörler takılı',
                'Flow switch takılı',
                'Emniyet, tahliye, hava alma var',
                'Akış yönü doğru',
            ]),
            araKontrol(),
        ]),
        mech('test', 'M-10', 'Soğutma devresi basınç testi', 25, [
            basincTesti('Soğutma devresi basınç testi', 'test basıncı, süre, sonuç.', ['Basınç ve süre yazılı', 'Düşüş onaylı limitte', 'Sonuç PASS']),
        ]),
        mech('test', 'M-11', 'Vakum ve akışkan', 25, [vakumSarj()]),
        mech('test', 'M-12', 'Su devresi testi', 25, [suDevresi()]),
        mech('test', 'M-13', 'Fonksiyon testi ve test çalışması', 25, [
            sub('Fonksiyon testi ve test çalışması', 'DOF', lines('test', 'ısıtma modu; destekliyorsa soğutma ve defrost/4-yollu vana; gidiş/dönüş sıcaklıkları, ΔT, basınçlar, set değer, akımlar.'), [
                'Isıtma modu çalışıyor',
                'Soğutma/defrost/4-yollu vana projeye göre test edildi',
                'Sıcaklıklar ve ΔT yazılı',
                'Set değere ulaşıldı',
                'Akımlar yazılı',
            ]),
        ]),
        mech('final', 'M-14', 'Final montaj ve QC', 100,
            finalAndShipping('Isı Pompası', 'izolasyon, kapaklar, etiketler, dış ortam koruması, bağlantı ağızları, temizlik.')),
        ...electricalTasks('Isı Pompası', {
            e09: 'fan/pompa/kompresör bağlantıları.',
            e14: 'kompresör/fan/pompa akımları, alarm fonksiyonları.',
        }),
    ],
};

export const OCC_SEED_TEMPLATES: readonly OccSeedTemplate[] = [CHILLER, DRY_COOLER, HEAT_PUMP];
