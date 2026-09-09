import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ICryptoService } from "../../interfaces/ICryptoService";
import { ITokenService } from "../../interfaces/ITokenService";
import { RefreshSessionContext } from "../../../infrastructure/services/RefreshSessionService";
import { PublicError } from "../../errors/AuthErrors";
import { assertLoginAllowed, recordLoginFailure, clearLoginFailures } from "../../services/loginThrottle";
import { runBcryptGuarded } from "../../services/bcryptGate";
import { buildMfaChallenge, MfaChallenge } from "./MfaUseCases";

/**
 * Seit dem 09.09.2026 endet die richtige Kennworteingabe NICHT mehr in einer
 * Sitzung, sondern in der zweiten Hälfte der Anmeldung: dem sechsstelligen
 * Code aus der Authenticator-App (siehe MfaUseCases). Ausgestellt wird hier
 * nur noch das Zwischentoken; Zugangs- und Erneuerungstoken folgen erst, wenn
 * der Code stimmt.
 */
export class LoginUseCase {
    // bcrypt(cost 12) hash of a random throwaway string — compared against when
    // the e-mail is unknown so every login attempt costs the same wall time.
    private static readonly DUMMY_PASSWORD_HASH =
        '$2b$12$pnTvvJV1RFRAnjBSDLGVEejwkDI5j2V36hQM/LjiV7wGT/Xg9yTf6';

    constructor(

        private employeeRepo : IEmployeeRepository,
        private cryptoService : ICryptoService,
        private tokenService : ITokenService

    ){}

    async execute(email:string , plainpassword:string, context: RefreshSessionContext = {}): Promise<MfaChallenge>{
        // Generic credentials error (same for unknown email, deleted/banned
        // account and wrong password) so the endpoint can't enumerate accounts.
        const invalidCredentials = () => new PublicError("E-posta veya parola hatalı.");

        /* Kontosperre VOR der Kennwortprüfung. Sie hängt an der eingegebenen
           Adresse, nicht am gefundenen Konto — sonst verriete die Sperre, welche
           Adressen es gibt (siehe loginThrottle). Der IP-Zähler der Route bleibt
           daneben bestehen; er fängt den Angreifer auf EINEM Anschluss ab,
           dieser hier den, der seine Versuche über viele Anschlüsse verteilt. */
        assertLoginAllowed(email);

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
        const isPasswordValid = await runBcryptGuarded(context.ipAddress, () =>
            this.cryptoService.comparePassword(
                plainpassword,
                employee?.passwordHash ?? LoginUseCase.DUMMY_PASSWORD_HASH,
            ));

        if(!employee || employee.deletedAt || employee.bannedAt || !isPasswordValid) {
            recordLoginFailure(email);
            throw invalidCredentials();
        }

        // Das Kennwort STIMMTE — der Zähler dieses Kontos ist damit erledigt,
        // auch wenn die Anmeldung gleich an einem anderen Grund scheitert.
        clearLoginFailures(email);

        // Only revealed to someone holding the CORRECT password — the inactive
        // state can't be probed with credential guesses.
        if(!employee.isActive) throw new PublicError("Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");

        /* ── HIER ENDET DIE ERSTE HÄLFTE ─────────────────────────────────────
           Das Kennwort stimmt, das Konto ist in Ordnung — und trotzdem gibt es
           noch keine Sitzung. Was zurückgeht, ist die AUFFORDERUNG zum zweiten
           Faktor: der sechsstellige Code aus der Authenticator-App. Erst
           `VerifyMfaCodeUseCase` stellt die Token aus.

           Wer noch kein Geheimnis eingerichtet hat, bekommt in derselben
           Antwort eines vorgeschlagen (QR-Bild zum Scannen). Der Faktor gilt
           damit ab der ersten Anmeldung, ohne dass jemand vorher etwas
           verteilen muss — siehe MfaUseCases. */
        return buildMfaChallenge(this.tokenService, employee);
    }


}
