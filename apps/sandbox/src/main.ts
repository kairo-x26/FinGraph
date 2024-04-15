import { createSandbox } from './index';

const port = Number(process.env.SANDBOX_PORT ?? 4100);
const issuer = process.env.SANDBOX_ISSUER ?? `http://localhost:${port}`;
const apiCallbackBase = process.env.SANDBOX_CALLBACK_BASE ?? 'http://localhost:3000/api';

const sandbox = await createSandbox({ issuer, apiCallbackBase, logger: true });
await sandbox.listen(port, process.env.SANDBOX_HOST ?? '127.0.0.1');
console.log(`sandbox IdP ready at ${issuer}`);
