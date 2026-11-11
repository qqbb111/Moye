import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ReadableStream } from 'node:stream/web';
import type { UpdateState } from '../shared/types';

const repository = 'qqbb111/Moye';
const latestRelease = `https://api.github.com/repos/${repository}/releases/latest`;
const maxDownload = 400 * 1024 * 1024;
const stableVersion = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
// Windows PowerShell needs a console. A hidden launcher gives the update process
// its own hidden console and lets it outlive the Electron process.
const launchHelper = `
$ErrorActionPreference = 'Stop'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $PSHOME 'powershell.exe'
$start.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "& ([scriptblock]::Create([IO.File]::ReadAllText($env:MOYE_UPDATE_RUNNER)))"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
[void][Diagnostics.Process]::Start($start)
`;
interface UpdateAsset { version: string; url: string; sha256: string; size: number }
interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string; digest?: string; size?: number; state?: string }[];
}

export function updateAsset(release: GitHubRelease, installed: string): UpdateAsset | undefined {
  const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  if (release?.draft || release?.prerelease || !stableVersion.test(version) || !stableVersion.test(installed)) throw new Error('无法识别 GitHub 发布版本。');
  const old = installed.split('.').map(Number);
  const difference = version.split('.').map((part, index) => Number(part) - old[index]).find(value => value !== 0) ?? 0;
  if (difference <= 0) return;

  const filename = `Moye-${version}-windows-x64.zip`;
  const url = `https://github.com/${repository}/releases/download/v${version}/${filename}`;
  const asset = Array.isArray(release.assets) ? release.assets.find(item => item?.name === filename) : undefined;
  if (asset?.state !== 'uploaded' || asset.browser_download_url !== url || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size! <= 0 || asset.size! > maxDownload) {
    throw new Error('新版尚未提供可校验的 Windows x64 更新包。');
  }
  return { version, url, sha256: asset.digest.slice(7), size: asset.size! };
}

interface Options {
  version: string;
  executable: string;
  userData: string;
  supported: boolean;
  request: (url: string, options: RequestInit) => Promise<Response>;
  changed: (state: UpdateState) => void;
}

export class PortableUpdates {
  state: UpdateState;
  private asset?: UpdateAsset;
  private stage?: string;
  private abort?: AbortController;
  private downloadTask?: Promise<void>;

  constructor(private readonly options: Options) {
    this.state = options.supported ? { phase: 'idle' } : { phase: 'unsupported', message: '应用内更新适用于 Windows x64 发布版。' };
  }

  private set(state: UpdateState) { this.state = state; this.options.changed(state); }

  async check() {
    if (!['idle', 'current', 'available', 'error'].includes(this.state.phase)) return;
    this.asset = undefined;
    this.set({ phase: 'checking' });
    try {
      const response = await this.options.request(latestRelease, { redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Moye' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('暂时无法查询 GitHub 更新，请稍后重试。');
      this.asset = updateAsset(await response.json() as GitHubRelease, this.options.version);
      this.set(this.asset ? { phase: 'available', version: this.asset.version } : { phase: 'current' });
    } catch (error) {
      this.set({ phase: 'error', message: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '暂时无法查询 GitHub 更新，请稍后重试。' });
    }
  }

  cancel() { if (this.state.phase === 'downloading') this.abort?.abort(); }

  download() {
    const asset = this.asset;
    if (!asset || this.state.phase !== 'available') return;
    const task = this.prepare(asset).finally(() => { this.downloadTask = undefined; });
    this.downloadTask = task;
    return task;
  }

  private async prepare(asset: UpdateAsset) {
    this.set({ phase: 'downloading', version: asset.version, percent: 0 });
    const abort = new AbortController(); this.abort = abort;
    let stage: string | undefined;
    try {
      const root = await fs.realpath(path.dirname(this.options.executable));
      stage = await fs.mkdtemp(path.join(root, '.moye-update-')).catch(() => { throw new Error('墨页所在目录无法写入，无法就地更新。'); });
      const zip = path.join(stage, 'download.zip');
      const response = await this.options.request(asset.url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60 * 1000)]) });
      const endpoint = new URL(response.url || asset.url);
      if (endpoint.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(endpoint.hostname) || !response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error('无法从 GitHub 下载更新包。');
      }
      const digest = createHash('sha256'); let received = 0; let percent = 0;
      const inspect = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
        received += chunk.length;
        if (received > asset.size) { done(new Error('更新包大小与 GitHub 记录不符。')); return; }
        digest.update(chunk);
        const next = Math.floor(received * 100 / asset.size);
        if (next > percent) { percent = next; this.set({ phase: 'downloading', version: asset.version, percent }); }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), inspect, createWriteStream(zip, { flags: 'wx' }), { signal: abort.signal });
      if (received !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error('更新包校验失败，请重新下载。');

      this.set({ phase: 'preparing', version: asset.version });
      await this.helper(stage, 'extract');
      const metadata = JSON.parse(await fs.readFile(path.join(stage, 'payload', 'resources', 'app.asar', 'package.json'), 'utf8'));
      if (metadata.version !== asset.version || metadata.name !== 'typora-replica') throw new Error('更新包内的应用版本与发布记录不符。');
      this.stage = stage;
      this.set({ phase: 'ready', version: asset.version });
    } catch (error) {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      this.set(abort.signal.aborted ? { phase: 'available', version: asset.version } : { phase: 'error', message: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '更新下载或解压失败，请重试。' });
    } finally { this.abort = undefined; }
  }

  async install(save: () => Promise<void>) {
    if (this.state.phase !== 'ready' || !this.stage || !this.asset) return false;
    const { version } = this.asset;
    this.set({ phase: 'installing', version });
    try {
      await save();
      await this.helper(this.stage, 'apply');
      this.stage = undefined;
      return true;
    } catch {
      this.set({ phase: 'ready', version, message: '无法保存草稿或启动更新，请重试。' });
      return false;
    }
  }

  async discard() {
    this.abort?.abort();
    await this.downloadTask;
    if (this.stage) {
      await fs.rm(this.stage, { recursive: true, force: true }).catch(() => {});
      this.stage = undefined;
    }
  }

  private async helper(stage: string, mode: 'extract' | 'apply') {
    const script = await fs.readFile(path.join(__dirname, 'portable-update.ps1'), 'utf8');
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const target = path.join(path.dirname(stage), path.basename(this.options.executable));
    const job = randomUUID();
    const runner = path.join(stage, `apply-${job}.ps1`);
    const ready = path.join(stage, `helper-ready-${job}`);
    const confirmation = path.join(stage, `helper-go-${job}`);
    if (mode === 'apply') await fs.writeFile(runner, script, { flag: 'wx' });
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', mode === 'extract' ? script : launchHelper], {
      cwd: path.dirname(stage), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, MOYE_UPDATE_MODE: mode, MOYE_UPDATE_EXE: target, MOYE_UPDATE_STAGE: stage, MOYE_UPDATE_RUNNER: runner, MOYE_UPDATE_JOB: job, MOYE_UPDATE_PID: String(process.pid), MOYE_UPDATE_RESULT: path.join(this.options.userData, 'portable-update-result') },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Windows 更新进程执行失败。')));
    });
    if (mode === 'extract') return;
    for (let attempts = 0; attempts < 150; attempts++) {
      if (await fs.access(ready).then(() => true, () => false)) { await fs.writeFile(confirmation, 'install'); return; }
      await sleep(50);
    }
    throw new Error('更新进程未就绪。');
  }

  async takeResult() {
    const result = path.join(this.options.userData, 'portable-update-result');
    const outcome = await fs.readFile(result, 'utf8').catch(() => '');
    if (!outcome) return;
    await fs.unlink(result).catch(() => {});
    if (outcome === 'installed') this.set({ phase: 'current', message: `已更新到 ${this.options.version}。` });
    else this.set({ phase: 'error', message: '更新未完成。可以重新检查并下载。' });
  }
}
