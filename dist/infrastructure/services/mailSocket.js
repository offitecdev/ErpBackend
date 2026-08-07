"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upgradeToTls = exports.openSocket = exports.sniFor = exports.budgetForMessage = exports.MailDeadline = exports.TLS_HANDSHAKE_TIMEOUT_MS = exports.DATA_TIMEOUT_MS = exports.COMMAND_TIMEOUT_MS = exports.CONNECT_TIMEOUT_MS = void 0;
const net_1 = __importDefault(require("net"));
const tls_1 = __importDefault(require("tls"));
/** SMTP ve IMAP istemcileri aynı bağlantı kurulumunu paylaşır: tek kopya
    kalsın diye buradadır (hata metinlerindeki protokol adı `label` ile
    verilir). Sunucu yanıt vermezse istek sonsuza kadar asılı kalmasın. */
exports.CONNECT_TIMEOUT_MS = 15_000;
exports.COMMAND_TIMEOUT_MS = 30_000;
exports.DATA_TIMEOUT_MS = 120_000;
/** TLS el sıkışmasının KENDİ zaman aşımı: `tls.connect` bir soket üzerine
    kurulduğunda `setTimeout` MİRAS ALINMAZ — sunucu ClientHello'ya hiç
    cevap vermezse söz (promise) sonsuza kadar askıda kalırdı. */
exports.TLS_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * ── TOPLAM SÜRE BÜTÇESİ ─────────────────────────────────────────────────────
 * Adım başına zaman aşımları tek bir adımın asılı kalmasını engeller ama
 * TOPLAMI engellemez: bağlan + karşılama + EHLO + STARTTLS + EHLO + AUTH +
 * MAIL/RCPT/DATA zincirinin her halkası ayrı ayrı zaman aşımına uğrayabilir
 * ve istek dakikalarca açık kalır — kullanıcı tarafında bu "sonsuza kadar
 * dönen" bir gönder düğmesidir.
 *
 * `MailDeadline` gönderimin tamamına tek bir duvar-saati bütçesi verir: her
 * adım bütçenin KALANIYLA sınırlanır, bütçe biterse gönderim hemen hata ile
 * sonlanır. Böylece uç noktanın en kötü yanıt süresi öngörülebilir olur.
 */
class MailDeadline {
    label;
    endsAt;
    constructor(budgetMs, label) {
        this.label = label;
        this.endsAt = Date.now() + Math.max(1, budgetMs);
    }
    get remainingMs() {
        return this.endsAt - Date.now();
    }
    /** Bütçe dolduysa fırlatır; dolmadıysa adımın kullanabileceği süreyi verir. */
    slice(preferredMs) {
        const remaining = this.remainingMs;
        if (remaining <= 0)
            throw new Error(this.timeoutError());
        return Math.max(1, Math.min(preferredMs, remaining));
    }
    /** Hata metni `SMTP`/`IMAP` ile başlar: çağıran uçlar bu ön eke bakarak
        kullanıcıya "mail ayarlarını kontrol edin" mesajını gösterir. */
    timeoutError() {
        return `${this.label} gonderimi icin ayrilan sure doldu: sunucu zamaninda yanit vermedi.`;
    }
}
exports.MailDeadline = MailDeadline;
/**
 * Gövde ne kadar büyükse sunucunun mesajı kabul etmesi o kadar sürer: sabit
 * bütçeye ek olarak mesaj boyutuna göre pay verilir (≈512 KB/sn'lik kötümser
 * bir yükleme hızı varsayımı — 15 MB'lık bir ek yaklaşık 30 sn ekler). Tavan
 * olmadan tek bir büyük ek bütçenin tamamını yiyebilirdi.
 */
const budgetForMessage = (baseMs, messageBytes, maxExtraMs) => baseMs + Math.min(maxExtraMs, Math.ceil(messageBytes / (512 * 1024)) * 1000);
exports.budgetForMessage = budgetForMessage;
/** SNI, IP literalleri için gönderilmez (RFC 6066). */
const sniFor = (host) => (net_1.default.isIP(host) ? undefined : host);
exports.sniFor = sniFor;
const openSocket = (host, port, secure, label, timeoutMs = exports.CONNECT_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const socket = secure
        ? tls_1.default.connect({ host, port, servername: (0, exports.sniFor)(host) })
        : net_1.default.connect({ host, port });
    const readyEvent = secure ? "secureConnect" : "connect";
    const cleanup = () => {
        socket.setTimeout(0);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
        socket.off(readyEvent, onReady);
    };
    const fail = (message) => {
        cleanup();
        socket.destroy();
        reject(new Error(message));
    };
    function onError(error) {
        fail(`${label} sunucusuna baglanilamadi (${host}:${port}): ${error.message}`);
    }
    function onTimeout() {
        fail(`${label} sunucusuna baglanilamadi (${host}:${port}): baglanti zaman asimina ugradi.`);
    }
    function onReady() {
        cleanup();
        resolve(socket);
    }
    socket.setTimeout(timeoutMs);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once(readyEvent, onReady);
});
exports.openSocket = openSocket;
/** STARTTLS sonrası aynı bağlantıyı TLS'e yükseltir. El sıkışmanın da süresi
    vardır: sunucu şifreli kanalı açmadan susarsa istek burada SONSUZA KADAR
    asılı kalırdı (gönderim ekranı hiç dönmeyen bir "gönderiliyor" gösterirdi). */
const upgradeToTls = (socket, host, label, timeoutMs = exports.TLS_HANDSHAKE_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const secure = tls_1.default.connect({ socket, servername: (0, exports.sniFor)(host) });
    const cleanup = () => {
        clearTimeout(timer);
        secure.off("error", onError);
        secure.off("secureConnect", onReady);
    };
    const timer = setTimeout(() => {
        cleanup();
        secure.destroy();
        reject(new Error(`${label} TLS el sikismasi zaman asimina ugradi (${host}).`));
    }, timeoutMs);
    function onError(error) {
        cleanup();
        secure.destroy();
        reject(new Error(`${label} TLS el sikismasi basarisiz (${host}): ${error.message}`));
    }
    function onReady() {
        cleanup();
        resolve(secure);
    }
    secure.once("error", onError);
    secure.once("secureConnect", onReady);
});
exports.upgradeToTls = upgradeToTls;
//# sourceMappingURL=mailSocket.js.map