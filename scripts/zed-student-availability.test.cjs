const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const vm = require('node:vm');
const { applyZedStudentAvailability } = require('./zed-student-availability.cjs');

const source = path.resolve(process.argv[2]);
const ts = require(path.join(source, 'node_modules/typescript'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-student-patch-'));
const files = ['src-tauri/src/models/zed.rs', 'src-tauri/src/modules/zed_account.rs',
  'src/types/zed.ts', 'src/pages/ZedAccountsPage.tsx'];
try {
  for (const file of files) {
    const original = cp.spawnSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8' });
    assert.equal(original.status, 0, original.stderr);
    fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
    fs.writeFileSync(path.join(temp, file), original.stdout);
  }
  applyZedStudentAvailability(temp);
  const backend = fs.readFileSync(path.join(temp, files[1]), 'utf8');
  assert.match(backend, /include!\("zed_student_hosted_ai.rs"\)/);
  assert.match(backend, /for mut stored in accounts/);
  assert.match(backend, /stored.public_account.hosted_ai_available = None/);
  const page = fs.readFileSync(path.join(temp, files[3]), 'utf8');
  const start = page.indexOf("      if (getZedPlanBadge(account) === 'STUDENT') {");
  const end = page.indexOf('      if (!hasZedQuotaData(account)) {', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule('module.exports = (account) => {\n' + page.slice(start, end) + '\n};',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { module: { exports: null }, getZedPlanBadge: () => 'STUDENT',
    t: (_key, fallback) => typeof fallback === 'string' ? fallback : fallback.defaultValue,
    formatDateTime: () => 'test', locale: 'zh-CN' };
  vm.runInNewContext(code, context);
  const panel = context.module.exports;
  const label = (account) => panel(account).items[0].value;
  assert.equal(label({ hosted_ai_available: true }), '待检测，请刷新');
  assert.equal(label({ hosted_ai_available: true, hosted_ai_probe_version: 1 }), '待检测，请刷新');
  const checked = { hosted_ai_probe_version: 2, hosted_ai_checked_at: 1 };
  assert.equal(label({ ...checked, hosted_ai_available: false, hosted_ai_reason: 'quota_exhausted' }), 'Student 额度已用完');
  assert.equal(label({ ...checked, hosted_ai_available: false, hosted_ai_reason: 'permission_denied' }), '权限不足');
  assert.equal(label({ ...checked, hosted_ai_available: true, hosted_ai_reason: 'available' }), '可用');
  assert.equal(label({ ...checked, hosted_ai_available: null, hosted_ai_reason: 'unknown' }), '检测失败，请刷新');
  assert.equal(label({ ...checked, hosted_ai_available: null, hosted_ai_reason: 'rate_limited' }), '暂时限流，请稍后刷新');
  const before = files.map(file => fs.readFileSync(path.join(temp, file), 'utf8'));
  assert.throws(() => applyZedStudentAvailability(temp), /expected exactly one patch anchor/);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(temp, file), 'utf8')), before);
  console.log('Student patch application, legacy-cache UI, failure classification UI and repeat-application guards passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
