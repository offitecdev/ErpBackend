"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginUseCase = void 0;
const AuthErrors_1 = require("../../errors/AuthErrors");
const loginThrottle_1 = require("../../services/loginThrottle");
const bcryptGate_1 = require("../../services/bcryptGate");
const MfaUseCases_1 = require("./MfaUseCases");
/**
 * Seit dem 09.09.2026 endet die richtige Kennworteingabe NICHT mehr in einer
 * Sitzung, sondern in der zweiten Hälfte der Anmeldung: dem sechsstelligen
 * Code aus der Authenticator-App (siehe MfaUseCases). Ausgestellt wird hier
 * nur noch das Zwischentoken; Zugangs- und Erneuerungstoken folgen erst, wenn
 * der Code stimmt.
 */
class LoginUseCase {
    employeeRepo;
    cryptoService;
    tokenService;
    // bcrypt(cost 12) hash of a random throwaway string — compared against when
    // the e-mail is unknown so every login attempt costs the same wall time.
    static DUMMY_PASSWORD_HASH = '$2b$12$pnTvvJV1RFRAnjBSDLGVEejwkDI5j2V36hQM/LjiV7wGT/Xg9yTf6';
    constructor(employeeRepo, cryptoService, tokenService) {
        this.employeeRepo = employeeRepo;
        this.cryptoService = cryptoService;
        this.tokenService = tokenService;
    }
    async execute(email, plainpassword, context = {}) {
        // Generic credentials error (same for unknown email, deleted/banned
        // account and wrong password) so the endpoint can't enumerate accounts.
        const invalidCredentials = () => new AuthErrors_1.PublicError("E-posta veya parola hatalı.");
        /* Kontosperre VOR der Kennwortprüfung. Sie hängt an der eingegebenen
           Adresse, nicht am gefundenen Konto — sonst verriete die Sperre, welche
           Adressen es gibt (siehe loginThrottle). Der IP-Zähler der Route bleibt
           daneben bestehen; er fängt den Angreifer auf EINEM Anschluss ab,
           dieser hier den, der seine Versuche über viele Anschlüsse verteilt. */
        (0, loginThrottle_1.assertLoginAllowed)(email);
        const employee = await this.employeeRepo.findByEmail(email);
        /* Timing equalization: exactly one bcrypt compare runs on EVERY path.
           Unknown e-mails compare against a fixed dummy hash, so "user not
           found" and "wrong password" answer in the same timeframe with the
           same message — response timing can't be used to enumerate accounts.

           DIESER Vergleich ist zugleich die teuerste Stelle im ganzen
           unangemeldeten Weg: bcrypt mit Kostenfaktor 12 belegt für ~250-400 ms
           einen Platz im Threadpool, den sich Dateizugriffe und die
           Bildverkleinerung teilen. Vier davon gleichzeitig legten früher den
           ganzen Pool lahm — der IP-Zähler der Route greift dagegen nicht, weil
           er erst NACH der Antwort zählt. Die Schranke deckelt beides: wie viele
           Vergleiche überhaupt gleichzeitig laufen, und wie viele davon auf
           einen Aufrufer entfallen (bcryptGate.ts).

           Für die Zeitgleichheit ist sie unbedenklich: die Wartezeit hängt an
           der Gesamtlast, nie daran, ob es die Adresse gibt. */
        const isPasswordValid = await (0, bcryptGate_1.runBcryptGuarded)(context.ipAddress, () => this.cryptoService.comparePassword(plainpassword, employee?.passwordHash ?? LoginUseCase.DUMMY_PASSWORD_HASH));
        if (!employee || employee.deletedAt || employee.bannedAt || !isPasswordValid) {
            (0, loginThrottle_1.recordLoginFailure)(email);
            throw invalidCredentials();
        }
        // Das Kennwort STIMMTE — der Zähler dieses Kontos ist damit erledigt,
        // auch wenn die Anmeldung gleich an einem anderen Grund scheitert.
        (0, loginThrottle_1.clearLoginFailures)(email);
        // Only revealed to someone holding the CORRECT password — the inactive
        // state can't be probed with credential guesses.
        if (!employee.isActive)
            throw new AuthErrors_1.PublicError("Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");
        /* ── HIER ENDET DIE ERSTE HÄLFTE ─────────────────────────────────────
           Das Kennwort stimmt, das Konto ist in Ordnung — und trotzdem gibt es
           noch keine Sitzung. Was zurückgeht, ist die AUFFORDERUNG zum zweiten
           Faktor: der sechsstellige Code aus der Authenticator-App. Erst
           `VerifyMfaCodeUseCase` stellt die Token aus.

           Wer noch kein Geheimnis eingerichtet hat, bekommt in derselben
           Antwort eines vorgeschlagen (QR-Bild zum Scannen). Der Faktor gilt
           damit ab der ersten Anmeldung, ohne dass jemand vorher etwas
           verteilen muss — siehe MfaUseCases. */
        return (0, MfaUseCases_1.buildMfaChallenge)(this.tokenService, employee);
    }
}
exports.LoginUseCase = LoginUseCase;
//# sourceMappingURL=LoginUseCase.js.map