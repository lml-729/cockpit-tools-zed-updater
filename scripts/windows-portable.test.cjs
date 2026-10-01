const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { buildWindowsPortableArchive } = require('./windows-portable.cjs');

const app = path.resolve(process.argv[2] || path.join(__dirname, '../../cockpit-tools'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-portable-test-'));
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function readZip(file) {
  const bytes = fs.readFileSync(file);
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 6), 0, 'ZIP flags');
    assert.equal(bytes.readUInt16LE(offset + 8), 8, 'deflate compression');
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const size = bytes.readUInt32LE(offset + 22);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const start = offset + 30 + nameSize + extraSize;
    const data = zlib.inflateRawSync(bytes.subarray(start, start + compressedSize));
    assert.equal(data.length, size, name + ': length');
    assert.equal(crc32(data), bytes.readUInt32LE(offset + 14), name + ': CRC');
    assert.ok(!entries.has(name), name + ': duplicate entry');
    entries.set(name, data);
    offset = start + compressedSize;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'central directory exists');
  return entries;
}
function write(dir, name, content = name) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
try {
  const release = path.join(temp, 'release');
  const output = path.join(temp, 'out');
  const required = ['cockpit-tools.exe', 'cockpit-cliproxy.exe', 'WebView2Loader.dll',
    'scripts/claude-desktop-auth-helper.cjs', 'native-menu-icons/zed.png',
    'resources/nested/example.dat'];
  for (const name of required) write(release, name);
  for (const name of ['application.pdb', 'unrelated.exe', 'cache/secret.json', 'deps/old.dll', 'build/state.json']) write(release, name);
  const zip = buildWindowsPortableArchive({ app, releaseDir: release, outputDir: output, version: '1.3.64' });
  const prefix = 'Cockpit.Tools_1.3.64_x64-portable/';
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()].sort(), [...required.map(name => prefix + name), prefix + 'README.txt'].sort());
  for (const name of required) assert.deepEqual(entries.get(prefix + name), fs.readFileSync(path.join(release, name)));
  assert.match(entries.get(prefix + 'README.txt').toString(), /run cockpit-tools\.exe/);
  fs.renameSync(path.join(release, 'cockpit-tools.exe'), path.join(release, 'cockpit_tools.exe'));
  const alternative = readZip(buildWindowsPortableArchive({ app, releaseDir: release, outputDir: output, version: '1.3.64-test' }));
  assert.ok(alternative.has('Cockpit.Tools_1.3.64-test_x64-portable/cockpit_tools.exe'));
  fs.unlinkSync(path.join(release, 'cockpit_tools.exe'));
  assert.throws(() => buildWindowsPortableArchive({ app, releaseDir: release, outputDir: output, version: '1.3.64' }), /executable not found/);
  assert.throws(() => buildWindowsPortableArchive({ app, releaseDir: release, outputDir: output, version: '../bad' }), /Invalid Windows portable/);
  console.log('Portable fixture: root/nested resources, EXE variants, CRC and excluded build outputs passed.');

  const actual = path.join(app, 'target/release');
  if (['cockpit-tools.exe', 'cockpit_tools.exe'].some(name => fs.existsSync(path.join(actual, name)))) {
    const archive = buildWindowsPortableArchive({ app, releaseDir: actual, outputDir: path.join(temp, 'actual'), version: '1.3.64' });
    const actualEntries = readZip(archive);
    assert.ok(actualEntries.has(prefix + 'scripts/claude-desktop-auth-helper.cjs'));
    assert.ok(actualEntries.has(prefix + 'native-menu-icons/zed.png'));
    for (const [name, data] of actualEntries) {
      if (name === prefix + 'README.txt') continue;
      assert.deepEqual(data, fs.readFileSync(path.join(actual, name.slice(prefix.length))), name);
    }
    console.log(`Actual release ZIP: ${actualEntries.size} entries, CRC and byte contents passed.`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
