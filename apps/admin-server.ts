import { createAdminServer } from './admin-auth.js';
const record = process.env.ADMIN_PASSWORD_RECORD;
const port = Number(process.env.ADMIN_PORT ?? 3001);
if (!record || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid laboratory admin configuration');
const server = createAdminServer(record);
server.requestTimeout = 5000; server.headersTimeout = 6000;
server.listen(port, '127.0.0.1');
