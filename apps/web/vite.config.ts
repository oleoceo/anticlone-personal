import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  function git(args: string[]) {
    return spawnSync('git', args, {cwd, encoding: 'utf8'});
  }

  const revision = git(['rev-parse', '--verify', 'HEAD']);
  const commit = revision.status === 0 ? revision.stdout.trim() : '';
  const status = commit ? git(['status', '--porcelain', '--untracked-files=normal']) : undefined;
  const modified = !!status && (status.status !== 0 || status.stdout.trim() !== '');

  return {define: {
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(commit),
    'import.meta.env.VITE_BUILD_MODIFIED': JSON.stringify(modified),
  }};
});
