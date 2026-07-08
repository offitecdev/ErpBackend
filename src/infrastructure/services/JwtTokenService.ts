import jwt from 'jsonwebtoken';
import { ITokenService } from '../../application/interfaces/ITokenService';

export class JwtTokenService implements ITokenService {
    generateToken(payload: object): string {
        const secret = process.env.OFFITEC_JWT_SECRET;
        if (!secret) throw new Error('JWT Secret tanımlanmamış!');
        return jwt.sign(payload, secret, { expiresIn: '1d', algorithm: 'HS256' });
    }
}