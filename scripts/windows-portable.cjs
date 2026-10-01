const fs = require('node:fs');
const path = require('node:path');

function buildWindowsPortableArchive({ app, releaseDir, outputDir, version }) {
  if (!app || !releaseDir || !outputDir || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) {
    throw new Error('Invalid Windows portable build parameters');
  }
  const release = path.resolve(releaseDir);
  const output = path.resolve(outputDir);
  const archiveRoot = `Cockpit.Tools_${version}_x64-portable`;
  const createZip = require(path.resolve(app, 'scripts/release/build_windows_portable.cjs')).createZip;
  if (typeof createZip !== 'function') throw new Error('Upstream Windows ZIP writer is unavailable');
  const executable = ['cockpit-tools.exe', 'cockpit_tools.exe', 'Cockpit.Tools.exe', 'Cockpit Tools.exe']
    .find(name => fs.existsSync(path.join(release, name)) && fs.lstatSync(path.join(release, name)).isFile());
  if (!executable) throw new Error(`Windows application executable not found in ${release}`);

  const entries = [];
  const add = sourcePath => entries.push({ sourcePath, archivePath: path.join(archiveRoot, path.relative(release, sourcePath)) });
  add(path.join(release, executable));
  for (const entry of fs.readdirSync(release, { withFileTypes: true })) {
    if (entry.isFile() && (/^cockpit-cliproxy(?:[-_].*)?\.exe$/i.test(entry.name) || /^WebView2Loader\.dll$/i.test(entry.name))) {
      add(path.join(release, entry.name));
    }
  }
  function addDirectory(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) addDirectory(full);
      else if (entry.isFile()) add(full);
      else throw new Error(`Unsupported portable resource entry: ${full}`);
    }
  }
  // Windows Tauri versions emit resources either beside the EXE or under resources/.
  // Keep each generated path intact because resource_dir resolves these names at runtime.
  for (const name of ['resources', 'scripts', 'native-menu-icons']) {
    const dir = path.join(release, name);
    if (!fs.existsSync(dir)) continue;
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Portable resource directory is invalid: ${dir}`);
    addDirectory(dir);
  }
  entries.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  entries.push({
    archivePath: path.join(archiveRoot, 'README.txt'),
    content: Buffer.from('Cockpit Tools portable edition\r\n\r\n' +
      `Extract this folder and run ${executable}.\r\n` +
      'Windows 10/11 with Microsoft Edge WebView2 Runtime is required.\r\n' +
      '账号和配置仍按当前 Windows 用户目录保存，不会随 ZIP 文件夹自动迁移。\r\n', 'utf8'),
  });
  fs.mkdirSync(output, { recursive: true });
  const outputPath = path.join(output, `${archiveRoot}.zip`);
  fs.writeFileSync(outputPath, createZip(entries));
  return outputPath;
}

module.exports = { buildWindowsPortableArchive };
