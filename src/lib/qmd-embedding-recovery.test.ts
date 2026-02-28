import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { execFileSyncMock, getCollectionByNameMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  getCollectionByNameMock: vi.fn()
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: vi.fn()
}));

vi.mock('./qmd-collections.js', () => ({
  getCollectionByName: getCollectionByNameMock
}));

async function loadModule() {
  vi.resetModules();
  return await import('./qmd-embedding-recovery.js');
}

const createdTempDirs: string[] = [];

function makeTempVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawvault-qmd-recovery-'));
  createdTempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('qmd embedding recovery', () => {
  it('keeps WAL marker when embed crashes', async () => {
    const { runCrashSafeQmdEmbed, readQmdEmbedWalRecord } = await loadModule();
    const vaultPath = makeTempVault();
    const rootPath = path.join(vaultPath, 'notes');
    fs.mkdirSync(rootPath, { recursive: true });

    execFileSyncMock.mockImplementation(() => {
      throw new Error('qmd crashed');
    });

    expect(() => runCrashSafeQmdEmbed({
      vaultPath,
      collection: 'vault',
      rootPath
    })).toThrow('qmd crashed');

    const wal = readQmdEmbedWalRecord(vaultPath);
    expect(wal).not.toBeNull();
    expect(wal?.collection).toBe('vault');
    expect(wal?.rootPath).toBe(rootPath);
  });

  it('auto-recovers from interrupted WAL marker and clears it', async () => {
    const {
      runCrashSafeQmdEmbed,
      recoverQmdEmbeddingIfNeeded,
      readQmdEmbedWalRecord
    } = await loadModule();
    const vaultPath = makeTempVault();
    const rootPath = path.join(vaultPath, 'notes');
    fs.mkdirSync(rootPath, { recursive: true });

    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error('interrupted');
      })
      .mockImplementation(() => '');

    expect(() => runCrashSafeQmdEmbed({
      vaultPath,
      collection: 'vault',
      rootPath
    })).toThrow('interrupted');
    expect(readQmdEmbedWalRecord(vaultPath)).not.toBeNull();

    const result = recoverQmdEmbeddingIfNeeded({
      vaultPath,
      collection: 'vault',
      rootPath,
      mode: 'marker-only'
    });

    expect(result).toEqual({ recovered: true, reason: 'interrupted_wal' });
    expect(readQmdEmbedWalRecord(vaultPath)).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledWith('qmd', ['update', '-c', 'vault'], { stdio: 'inherit' });
    expect(execFileSyncMock).toHaveBeenCalledWith('qmd', ['embed', '-f', '-c', 'vault'], { stdio: 'inherit' });
  });

  it('rebuilds automatically when vectors are empty with no pending embeddings', async () => {
    const { recoverQmdEmbeddingIfNeeded } = await loadModule();
    const vaultPath = makeTempVault();
    const rootPath = path.join(vaultPath, 'notes');
    fs.mkdirSync(rootPath, { recursive: true });
    fs.writeFileSync(path.join(rootPath, 'doc.md'), '# note\n\nbody', 'utf-8');

    getCollectionByNameMock.mockReturnValue({
      name: 'vault',
      uri: 'qmd://vault',
      details: {},
      files: 0,
      vectors: 0,
      pendingEmbeddings: 0
    });
    execFileSyncMock.mockImplementation(() => '');

    const result = recoverQmdEmbeddingIfNeeded({
      vaultPath,
      collection: 'vault',
      rootPath,
      mode: 'marker-or-empty'
    });

    expect(result).toEqual({ recovered: true, reason: 'empty_vectors' });
    expect(execFileSyncMock).toHaveBeenCalledWith('qmd', ['update', '-c', 'vault'], { stdio: 'inherit' });
    expect(execFileSyncMock).toHaveBeenCalledWith('qmd', ['embed', '-f', '-c', 'vault'], { stdio: 'inherit' });
  });

  it('does not rebuild when vectors are pending (healthy incremental state)', async () => {
    const { recoverQmdEmbeddingIfNeeded } = await loadModule();
    const vaultPath = makeTempVault();
    const rootPath = path.join(vaultPath, 'notes');
    fs.mkdirSync(rootPath, { recursive: true });
    fs.writeFileSync(path.join(rootPath, 'doc.md'), '# note\n\nbody', 'utf-8');

    getCollectionByNameMock.mockReturnValue({
      name: 'vault',
      uri: 'qmd://vault',
      details: {},
      files: 10,
      vectors: 0,
      pendingEmbeddings: 10
    });

    const result = recoverQmdEmbeddingIfNeeded({
      vaultPath,
      collection: 'vault',
      rootPath,
      mode: 'marker-or-empty'
    });

    expect(result).toEqual({ recovered: false });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
