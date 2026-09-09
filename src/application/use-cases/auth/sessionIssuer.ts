import { ITokenService } from '../../interfaces/ITokenService';
import { toPwdAtClaim } from '../../../infrastructure/services/JwtTokenService';
import { startRefreshSession, RefreshSessionContext } from '../../../infrastructure/services/RefreshSessionService';

/**
 * Der letzte Schritt jeder Anmeldung: eine Sitzungszeile anlegen und die
 * beiden Token darauf ausstellen.
 *
 * Bis zum zweiten Faktor stand das nur in `LoginUseCase`. Seither entscheidet
 * die Kennworteingabe die Anmeldung nicht mehr — sie geht in die Codeeingabe
 * über, und erst DIE stellt die Sitzung aus. Damit gäbe es zwei Abschriften
 * derselben zwölf Zeilen; die zweite hätte irgendwann die `pwdAt`-Prüfung oder
 * die Sitzungszeile vergessen. Darum hier, an einer Stelle.
 */
export interface SessionEmployee {
    id: string;
    tenantId: string;
    email: string;
    firstName: string;
    lastName: string;
    passwordChangedAt?: Date | null | undefined;
}

export const issueEmployeeSession = async (
    tokenService: ITokenService,
    employee: SessionEmployee,
    context: RefreshSessionContext = {},
) => {
    const payload = {
        id: employee.id,
        tenantId: employee.tenantId,
        email: employee.email,
        pwdAt: toPwdAtClaim(employee.passwordChangedAt),
    };

    // Eine Anmeldung = eine Zeile. Das Erneuerungstoken trägt ihre Kennung,
    // damit Abmelden, Sperre und Wiedereinspielschutz greifen können
    // (RefreshSessionService).
    const session = await startRefreshSession(employee.id, employee.tenantId, context);

    return {
        accessToken: tokenService.generateToken('access', payload),
        refreshToken: tokenService.generateToken('refresh', { ...payload, ...session }),
        employee: {
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            tenantId: employee.tenantId,
        },
    };
};
