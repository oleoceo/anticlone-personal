import { readFile, rename, writeFile } from 'node:fs/promises';

type WorkerState = 'READY' | 'TRANSPORT_UNAVAILABLE' | 'QUEUE_ERROR';

export async function reportNotificationWorker(path: string | undefined, state: WorkerState, scoped: boolean, version: number | null) {
  if (!path) return;
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify({state, scoped, version, checkedAt: Date.now()}), {mode:0o600});
  await rename(temporary, path);
}

export async function notificationWorkerStatus(path = process.env.NOTIFICATION_WORKER_STATUS_PATH) {
  if (!path) return {state:'NOT_CONFIGURED'};
  try {
    const status = JSON.parse(await readFile(path,'utf8')) as {state: WorkerState; scoped: boolean; version: number | null; checkedAt: number};
    const age = Date.now() - status.checkedAt;
    if (!Number.isFinite(age) || age < 0 || age > 45_000 ||
        !['READY','TRANSPORT_UNAVAILABLE','QUEUE_ERROR'].includes(status.state)) return {state:'OFFLINE'};
    return {state:status.state, scoped:status.scoped === true, version:Number.isSafeInteger(status.version) ? status.version : null};
  } catch {
    return {state:'OFFLINE'};
  }
}
