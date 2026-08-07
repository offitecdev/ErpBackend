import net from "net";
import tls from "tls";

/** SMTP ve IMAP istemcileri aynı bağlantı kurulumunu paylaşır: tek kopya
    kalsın diye buradadır (hata metinlerindeki protokol adı `label` ile
    verilir). Sunucu yanıt vermezse istek sonsuza kadar asılı kalmasın. */
export const CONNECT_TIMEOUT_MS = 15_000;
export const COMMAND_TIMEOUT_MS = 30_000;
export const DATA_TIMEOUT_MS = 120_000;
/** TLS el sıkışmasının KENDİ zaman aşımı: `tls.connect` bir soket üzerine
    kurulduğunda `setTimeout` MİRAS ALINMAZ — sunucu ClientHello'ya hiç
    cevap vermezse söz (promise) sonsuza kadar askıda kalırdı. */
export const TLS_HANDSHAKE_TIMEOUT_MS = 15_000;

export type MailSocket = net.Socket | tls.TLSSocket;

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
export class MailDeadline {
    private readonly endsAt: number;

    constructor(budgetMs: number, private readonly label: string) {
        this.endsAt = Date.now() + Math.max(1, budgetMs);
    }

    get remainingMs(): number {
        return this.endsAt - Date.now();
    }

    /** Bütçe dolduysa fırlatır; dolmadıysa adımın kullanabileceği süreyi verir. */
    slice(preferredMs: number): number {
        const remaining = this.remainingMs;
        if (remaining <= 0) throw new Error(this.timeoutError());
        return Math.max(1, Math.min(preferredMs, remaining));
    }

    /** Hata metni `SMTP`/`IMAP` ile başlar: çağıran uçlar bu ön eke bakarak
        kullanıcıya "mail ayarlarını kontrol edin" mesajını gösterir. */
    timeoutError(): string {
        return `${this.label} gonderimi icin ayrilan sure doldu: sunucu zamaninda yanit vermedi.`;
    }
}

/**
 * Gövde ne kadar büyükse sunucunun mesajı kabul etmesi o kadar sürer: sabit
 * bütçeye ek olarak mesaj boyutuna göre pay verilir (≈512 KB/sn'lik kötümser
 * bir yükleme hızı varsayımı — 15 MB'lık bir ek yaklaşık 30 sn ekler). Tavan
 * olmadan tek bir büyük ek bütçenin tamamını yiyebilirdi.
 */
export const budgetForMessage = (baseMs: number, messageBytes: number, maxExtraMs: number): number =>
    baseMs + Math.min(maxExtraMs, Math.ceil(messageBytes / (512 * 1024)) * 1000);

/** SNI, IP literalleri için gönderilmez (RFC 6066). */
export const sniFor = (host: string) => (net.isIP(host) ? undefined : host);

export const openSocket = (
    host: string,
    port: number,
    secure: boolean,
    label: string,
    timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<MailSocket> =>
    new Promise((resolve, reject) => {
        const socket: MailSocket = secure
            ? tls.connect({ host, port, servername: sniFor(host) })
            : net.connect({ host, port });
        const readyEvent = secure ? "secureConnect" : "connect";
        const cleanup = () => {
            socket.setTimeout(0);
            socket.off("error", onError);
            socket.off("timeout", onTimeout);
            socket.off(readyEvent, onReady);
        };
        const fail = (message: string) => {
            cleanup();
            socket.destroy();
            reject(new Error(message));
        };
        function onError(error: Error) {
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

/** STARTTLS sonrası aynı bağlantıyı TLS'e yükseltir. El sıkışmanın da süresi
    vardır: sunucu şifreli kanalı açmadan susarsa istek burada SONSUZA KADAR
    asılı kalırdı (gönderim ekranı hiç dönmeyen bir "gönderiliyor" gösterirdi). */
export const upgradeToTls = (
    socket: MailSocket,
    host: string,
    label: string,
    timeoutMs = TLS_HANDSHAKE_TIMEOUT_MS,
): Promise<tls.TLSSocket> =>
    new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: sniFor(host) });
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
        function onError(error: Error) {
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
