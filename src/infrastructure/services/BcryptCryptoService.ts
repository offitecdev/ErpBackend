import bcrypt from 'bcrypt';
import { ICryptoService } from '../../application/interfaces/ICryptoService';

export class BcryptCryptoService implements ICryptoService {
    async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, 12);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }
}