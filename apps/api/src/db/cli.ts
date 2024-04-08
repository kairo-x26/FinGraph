import { loadConfig } from '../config';
import { createDatabase } from './index';
import { migrate } from './migrate';

const config = loadConfig();
const db = await createDatabase(config.DATABASE_URL, 1);
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');
await db.close();
