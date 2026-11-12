// Local server operator tool. Writes to a NEW protected file; never stdout or HTTP.
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {provisionCommerceSender} from './commerce.js';

const [id,file]=process.argv.slice(2);
if(process.platform==='win32')throw new Error('run on Linux/WSL server with a private operator directory; POSIX permissions required');
if(!id||!file||!process.env.DATABASE_URL)throw new Error('usage: commerce-provision CONNECTION_ID NEW_PRIVATE_FILE (server environment required)');
const db=new Pool({connectionString:process.env.DATABASE_URL});
try{const secret=await provisionCommerceSender(db,id,process.env);await writeFile(file,secret+'\n',{flag:'wx',mode:0o600});}
finally{await db.end();}
