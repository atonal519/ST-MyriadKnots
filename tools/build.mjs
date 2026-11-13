import { build } from 'vite';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, dirname, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function resolveOutputDirectory(value = 'dist') {
  const directory = resolve(projectRoot, value);
  if (directory !== resolve(projectRoot, 'dist') && (directory === resolve(projectRoot) || directory.startsWith(projectRoot)
    || projectRoot.startsWith(directory.endsWith(sep) ? directory : directory + sep))) {
    throw new Error('构建输出须使用dist或项目外的隔离目录。');
  }
  return directory;
}

export async function writeBuildOutputs(output, outDir = 'dist') {
  const directory = resolveOutputDirectory(outDir);
  const files = output.map(item => {
    const path = resolve(directory, item.fileName);
    if (isAbsolute(item.fileName) || !path.startsWith(directory + sep)) throw new Error('构建产物路径超出输出目录。');
    return { path, item, bytes: Buffer.from(item.type === 'chunk' ? item.code : item.source) };
  }).sort((left, right) => Number(left.item.isEntry === true) - Number(right.item.isEntry === true));
  const written = [], unchanged = [];
  // HTTP ETags include mtime. Keep identical files and old page dependencies in place.
  for (const { path, item, bytes } of files) {
    let previous;
    try { previous = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.equals(bytes)) { unchanged.push(item.fileName); continue; }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    written.push(item.fileName);
  }
  return { written, unchanged };
}

export async function buildPlugin({ outDir = 'dist', plugins = [] } = {}) {
  const directory = resolveOutputDirectory(outDir);
  const result = await build({ root: projectRoot, configFile: resolve(projectRoot, 'vite.config.js'), plugins,
    build: { outDir: directory, write: false, emptyOutDir: false } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  return writeBuildOutputs(output, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--outDir' || !args[1])) throw new Error('用法：npm run build -- [--outDir 输出目录]');
  const result = await buildPlugin({ outDir: args[1] });
  console.log(`写入 ${result.written.length} 项，保留 ${result.unchanged.length} 项未变产物。`);
}
