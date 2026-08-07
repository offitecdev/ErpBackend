"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.raiseDocumentCounter = exports.nextDocumentNumber = exports.parseDocumentNumber = exports.formatDocumentNumber = exports.DOCUMENT_BLOCK_SIZE = exports.DOCUMENT_SEQ_PAD = exports.DOCUMENT_PREFIX = void 0;
/**
 * BELGE KODU ÜRETİCİSİ — ÖNEK-YIL-NNNNN (örn. AN-2026-10001).
 *
 * Tek kural: **kod her dilde aynıdır.** Eskiden teklif numarası frontend'de
 * `Math.random()` ile üretiliyor (A-2026-4474) ve ekranda arayüz diline göre
 * A-/O-/T-, sipariş kodu da AUF-/ORD-/SIP- diye yeniden yazılıyordu. Artık kod
 * yalnızca burada, sunucuda üretilir; ne istemci ne de dil onu değiştirir.
 *
 *   QUOTE   → AN-2026-10001   Angebot   / Quote            / Teklif
 *   PROJECT → PR-2026-10001   Projekt   / Project          / Proje
 *   ORDER   → AU-2026-10001   Auftrag   / Order            / Sipariş
 *   ADDON   → NT-2026-10001   Nachtrag  / Additional order / Ek sipariş
 *   INVOICE → RE-2026-10001   Rechnung  / Invoice          / Fatura
 *
 * ── Sıranın ilk hanesi ŞİRKETİN NUMARASIDIR ──────────────────────────────────
 * Sıra 1'den değil, şirketin kendi BLOĞUNDAN başlar: blok =
 * `Tenant.companyNumber × 10000`. Numarası 1 olan şirket 10001'den, numarası 4
 * olan şirket 40001'den sayar; numarası 0 olan (varsayılan) 00001'den.
 *
 * Numara /settings/company-categories altında ŞİRKET BAŞINA düzenlenir ve modül
 * kategorisinden BAĞIMSIZDIR — aynı modül paketini paylaşan iki şirket farklı
 * numara taşıyabilir. (Numara eskiden kategoriden geliyordu; 20260804180000
 * geçişi onu şirkete taşıdı ve mevcut blokları koruyacak şekilde doldurdu.)
 *
 * ── Yıl yalnızca ETİKETTİR, sayaç yıl başında SIFIRLANMAZ ────────────────────
 * Koddaki yıl belgenin oluşturulduğu andaki yıldır; 2027'ye girildiğinde yeni
 * belgeler kendiliğinden AN-2027-… olur ama sıra kaldığı yerden devam eder
 * (…-2026-10003 → …-2027-10004). Bu yüzden sayaç satırı yıl taşımaz.
 *
 * ⚠ Sayaç şirketin GÜNCEL bloğunu İKİ YÖNDE izler (kullanıcı kuralı
 * 2026-08-07: kodun ilk hanesi HER belge türünde şirket numarasıdır). Blok
 * yukarı taşınırsa kod yeni bloğa atlar (10003 → 40001); sayaç güncel bloğun
 * DIŞINDA kaldıysa (numara düşürüldü ya da eski tohumlama başka bloğa oturttu)
 * bir sonraki belge bloğa GERİ DÖNER. Geri dönüş hiçbir sırayı ikinci kez
 * dağıtmaz: hedef blokta o türden dağıtılmış EN YÜKSEK kodun üstüne oturur
 * (türetilmiş sipariş kodları dahil — tablodan taranır).
 *
 * ⚠ Bir blok 9999 belgeyi aşarsa (kategori 1 için 20000) kod bir üst bloğun
 * aralığına taşar ve blok geri-dönüşü o tür için devre dışı kalır (aksi tekrar
 * dağıtım olurdu). Sıra tenant içinde tekil kalmayı sürdürür — kodlar zaten
 * tenant başına üretilir, sistem genelinde tekil değildir.
 *
 * ⚠ Satın alma siparişleri (PurchaseOrder) BU SERİNİN DIŞINDADIR; onlar
 * BE-{yıl}-{sıra} biçimini korur (inventory.routes.ts).
 */
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
exports.DOCUMENT_PREFIX = {
    QUOTE: 'AN',
    PROJECT: 'PR',
    ORDER: 'AU',
    ADDON: 'NT',
    INVOICE: 'RE',
};
/** Sıra alanı 5 hanedir (blok + sayaç); 99999'dan sonra doğal olarak taşar. */
exports.DOCUMENT_SEQ_PAD = 5;
/** Şirket kategorisi numarasının sıraya çevrildiği çarpan: kategori 1 → 10000. */
exports.DOCUMENT_BLOCK_SIZE = 10000;
/**
 * Her belge türünün DAĞITILMIŞ kodlarının yaşadığı tablo/kolon. Sayaç şirketin
 * bloğuna GERİ dönerken çakışma kontrolü buradan yapılır — sayaçtan üretilmemiş
 * (teklif sırasından TÜRETİLMİŞ AU/NT) kodlar da bu tarama sayesinde görülür.
 */
const ISSUED_NUMBER_SOURCE = {
    QUOTE: { table: 'Tender', column: 'tenderNumber' },
    PROJECT: { table: 'Project', column: 'projectNumber' },
    ORDER: { table: 'SalesOrder', column: 'orderNumber' },
    ADDON: { table: 'SalesOrder', column: 'orderNumber' },
    INVOICE: { table: 'Invoice', column: 'invoiceNumber' },
};
/**
 * Hedef blokta o türden dağıtılmış EN YÜKSEK sıra (yoksa 0). Önek REGEXP'i
 * AU/NT gibi aynı tabloyu paylaşan türleri ayırır; eski biçimli kodlar
 * (legacyNumber'a taşınmış olanlar) kalıba uymadığı için sayılmaz.
 */
const maxIssuedSeqInBlock = async (client, tenantId, docType, floor, blockEnd) => {
    const source = ISSUED_NUMBER_SOURCE[docType];
    const pattern = `^${exports.DOCUMENT_PREFIX[docType]}-[0-9]{4}-[0-9]+$`;
    const rows = await client.$queryRawUnsafe(`SELECT MAX(CAST(SUBSTRING_INDEX(\`${source.column}\`, '-', -1) AS UNSIGNED)) AS maxSeq
         FROM \`${source.table}\`
         WHERE \`tenantId\` = ?
           AND \`${source.column}\` REGEXP ?
           AND CAST(SUBSTRING_INDEX(\`${source.column}\`, '-', -1) AS UNSIGNED) BETWEEN ? AND ?`, tenantId, pattern, floor, blockEnd);
    const maxSeq = Number(rows?.[0]?.maxSeq ?? 0);
    return Number.isFinite(maxSeq) ? maxSeq : 0;
};
const formatDocumentNumber = (type, year, seq) => `${exports.DOCUMENT_PREFIX[type]}-${year}-${String(Math.max(1, Math.trunc(seq))).padStart(exports.DOCUMENT_SEQ_PAD, '0')}`;
exports.formatDocumentNumber = formatDocumentNumber;
/**
 * "AN-2026-10007" gibi bir kodu çözer; verilen türün biçimine uymuyorsa null.
 * Teklif kodunu izleyen sipariş kodu (AN-… → AU-…) bunun üzerinden türetilir.
 */
const parseDocumentNumber = (value, type) => {
    const match = String(value || '').trim().match(new RegExp(`^${exports.DOCUMENT_PREFIX[type]}-(\\d{4})-(\\d+)$`));
    if (!match)
        return null;
    const year = Number(match[1]);
    const seq = Number(match[2]);
    return Number.isFinite(year) && Number.isFinite(seq) && seq >= 1 ? { year, seq } : null;
};
exports.parseDocumentNumber = parseDocumentNumber;
/**
 * Şirketin sıra bloğunun başlangıcı: şirket numarası × 10000.
 * Numarası 0 olan şirket blok 0'dır (00001'den sayar).
 */
const blockStartFor = async (client, tenantId) => {
    const rows = await client.$queryRaw `
        SELECT \`companyNumber\` FROM \`Tenant\` WHERE \`id\` = ${tenantId} LIMIT 1`;
    const companyNumber = Number(rows?.[0]?.companyNumber ?? 0);
    return (Number.isFinite(companyNumber) ? Math.max(0, Math.trunc(companyNumber)) : 0) * exports.DOCUMENT_BLOCK_SIZE;
};
/**
 * Sayacı atomik olarak bir artırır ve yeni değeri döndürür.
 *
 * MySQL'in klasik "sequence" kalıbı: `LAST_INSERT_ID(expr)` oturumun son-ekleme
 * değerini `expr`e ayarlar, `SELECT LAST_INSERT_ID()` onu geri okur. İki ifade
 * de AYNI BAĞLANTIDA çalışmak zorundadır — bu yüzden çağrı her zaman bir
 * transaction içinde yapılır (Prisma interaktif transaction tek bağlantıya
 * sabitler). Havuzdan rastgele bağlantı alan çıplak client ile çalıştırılırsa
 * iki istek birbirinin numarasını okuyabilir.
 *
 * `ON DUPLICATE KEY UPDATE` satır kilidi transaction bitene kadar tutulur, yani
 * eşzamanlı iki belge sıraya girer; aynı numara iki kez dağıtılmaz.
 */
const bumpCounter = async (client, tenantId, docType) => {
    // Şirketin bloğu her artışta yeniden okunur: numara ayarlardan
    // değiştirildiğinde bir sonraki belge yeni bloğa geçer.
    const block = await blockStartFor(client, tenantId);
    const floor = block + 1;
    const blockEnd = block + exports.DOCUMENT_BLOCK_SIZE - 1;
    // Mevcut sayaç satırı kilitlenerek okunur (FOR UPDATE): blok-dışı tespiti
    // ile yazma arasına eşzamanlı ikinci bir belge giremez. Satır yoksa kilit
    // de yoktur — o durumda aşağıdaki INSERT'in tekil anahtarı sıraya sokar.
    const currentRows = await client.$queryRaw `
        SELECT \`lastValue\` FROM \`DocumentCounter\`
        WHERE \`tenantId\` = ${tenantId} AND \`docType\` = ${docType}
        FOR UPDATE`;
    const current = currentRows.length ? Number(currentRows[0]?.lastValue ?? 0) : null;
    // Sayaç güncel bloğun DIŞINDAYSA bloğa GERİ DÖNER (kullanıcı kuralı
    // 2026-08-07: ilk hane her belgede şirket numarası). Hedef blokta o türden
    // dağıtılmış en yüksek kodun üstüne oturur; blok doluysa (9999 belge) geri
    // dönüş iptal — eski "asla geri gitme" yolu işler.
    let reseated = null;
    if (current !== null && (current < floor || current > blockEnd)) {
        const maxIssued = await maxIssuedSeqInBlock(client, tenantId, docType, floor, blockEnd);
        const next = Math.max(block, maxIssued) + 1;
        if (next <= blockEnd)
            reseated = next;
    }
    if (reseated !== null) {
        await client.$executeRaw `
            UPDATE \`DocumentCounter\`
            SET \`lastValue\` = LAST_INSERT_ID(${reseated}), \`updatedAt\` = NOW(3)
            WHERE \`tenantId\` = ${tenantId} AND \`docType\` = ${docType}`;
    }
    else {
        await client.$executeRaw `
            INSERT INTO \`DocumentCounter\` (\`tenantId\`, \`docType\`, \`lastValue\`, \`updatedAt\`)
            VALUES (${tenantId}, ${docType}, LAST_INSERT_ID(${floor}), NOW(3))
            ON DUPLICATE KEY UPDATE
                \`lastValue\` = LAST_INSERT_ID(GREATEST(\`lastValue\` + 1, ${floor})),
                \`updatedAt\` = NOW(3)`;
    }
    // mysql sürücüsü BIGINT döndürür; Number() ile daraltıyoruz.
    const rows = await client.$queryRaw `SELECT LAST_INSERT_ID() AS \`seq\``;
    const seq = Number(rows?.[0]?.seq ?? 0);
    if (!Number.isFinite(seq) || seq < 1) {
        throw new Error(`Belge numarası üretilemedi (${docType}).`);
    }
    return seq;
};
/**
 * Bir sonraki belge kodunu üretir — örn. `nextDocumentNumber(tenantId, 'QUOTE')`
 * → "AN-000042".
 *
 * @param tx Çağıran zaten bir transaction içindeyse O tx verilmelidir: numara
 * dış transaction ile birlikte commit/rollback olur, iptal edilen bir kayıt
 * sırada delik bırakmaz. Verilmezse kendi küçük transaction'ını açar.
 */
const nextDocumentNumber = async (tenantId, type, tx) => {
    if (!tenantId)
        throw new Error('Belge numarası için tenant zorunludur.');
    // Koddaki yıl belgenin OLUŞTURULDUĞU yıldır; sayaç sıfırlanmadığı için
    // 2027'nin ilk belgesi sıranın kaldığı yerden devam eder.
    const year = new Date().getFullYear();
    if (tx)
        return (0, exports.formatDocumentNumber)(type, year, await bumpCounter(tx, tenantId, type));
    return prisma_client_1.default.$transaction(async (client) => (0, exports.formatDocumentNumber)(type, year, await bumpCounter(client, tenantId, type)));
};
exports.nextDocumentNumber = nextDocumentNumber;
const raiseFloor = async (client, tenantId, docType, minValue) => {
    await client.$executeRaw `
        INSERT INTO \`DocumentCounter\` (\`tenantId\`, \`docType\`, \`lastValue\`, \`updatedAt\`)
        VALUES (${tenantId}, ${docType}, ${minValue}, NOW(3))
        ON DUPLICATE KEY UPDATE
            \`lastValue\` = GREATEST(\`lastValue\`, ${minValue}),
            \`updatedAt\` = NOW(3)`;
};
/**
 * Sayacı en az `minValue`ya çeker; asla geri götürmez.
 *
 * SAYAÇ DIŞINDAN türetilmiş bir kod dağıtıldığında çağrılır (sipariş kodu
 * teklifin sırasını kopyalar): sayaç türetilen sıranın gerisinde kalırsa,
 * sayaçtan üretilecek bir SONRAKİ (yedek) kod aynı sırayı ikinci kez verirdi.
 */
const raiseDocumentCounter = async (tenantId, type, minValue, tx) => {
    if (!tenantId)
        throw new Error('Belge numarası için tenant zorunludur.');
    const min = Math.max(1, Math.trunc(minValue));
    if (tx) {
        await raiseFloor(tx, tenantId, type, min);
        return;
    }
    await prisma_client_1.default.$transaction(async (client) => raiseFloor(client, tenantId, type, min));
};
exports.raiseDocumentCounter = raiseDocumentCounter;
//# sourceMappingURL=documentNumber.js.map