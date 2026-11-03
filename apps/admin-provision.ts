import { Secret } from 'otpauth';
import { randomBytes, scryptSync } from 'node:crypto';
// Run only in a trusted terminal. Output contains credentials; do not redirect to logs.
const password = randomBytes(32).toString('base64url');
const salt = randomBytes(16);
const record = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
const secret = new Secret({ size: 20 }).base32;
process.stdout.write(`TOTP secret (enter manually into authenticator): ${secret}\nADMIN_TOTP_SECRET (store as a secret): ${secret}\nPassword (save in password manager): ${password}\nADMIN_PASSWORD_RECORD (store as a secret): ${record}\n`);
