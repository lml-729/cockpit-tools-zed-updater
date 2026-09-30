const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Upstream source changed; refusing to publish without reviewing the patch.');
  return text.replace(from, to);
}

function customize(root, repository, publicKey) {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!publicKey || !/^[A-Za-z0-9+/=]+$/.test(publicKey.trim())) throw new Error('Missing or invalid updater public key');
  const page = path.join(root, 'src/pages/ZedAccountsPage.tsx');
  let source = fs.readFileSync(page, 'utf8').replace(/\r\n/g, '\n');
  source = replaceOnce(source, "import { compareCurrentAccountFirst } from '../utils/currentAccountSort';\n", '');
  source = replaceOnce(source, `      const currentFirstDiff = compareCurrentAccountFirst(left.id, right.id, currentAccountId);
      if (currentFirstDiff !== 0) {
        return currentFirstDiff;
      }

`, `      // Keep positions independent of the active account and backend recency.
      const stableTieBreak = () => left.id.localeCompare(right.id);
`);
  source = replaceOnce(source, 'if (leftValue == null && rightValue == null) return 0;', 'if (leftValue == null && rightValue == null) return stableTieBreak();');
  source = replaceOnce(source, '        return sortDirection === \'desc\' ? rightValue - leftValue : leftValue - rightValue;', `        const diff = sortDirection === 'desc' ? rightValue - leftValue : leftValue - rightValue;
        return diff || stableTieBreak();`);
  source = replaceOnce(source, "        return sortDirection === 'desc' ? diff : -diff;", "        return (sortDirection === 'desc' ? diff : -diff) || stableTieBreak();");
  source = replaceOnce(source, "      return sortDirection === 'desc' ? diff : -diff;", "      return (sortDirection === 'desc' ? diff : -diff) || stableTieBreak();");
  source = replaceOnce(source, '[currentAccountId, sortBy, sortDirection],', '[sortBy, sortDirection],');

  // Test the actual callback extracted from the patched component, not a separate implementation.
  const ts = require(path.join(root, 'node_modules/typescript'));
  const ast = ts.createSourceFile(page, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'compareAccountsBySort') callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!callback || !ts.isCallExpression(callback) || callback.arguments.length !== 2) throw new Error('Unexpected sort callback');
  if (callback.getText(ast).includes('currentAccountId') || callback.getText(ast).includes('compareCurrentAccountFirst')) throw new Error('Active-account promotion remains');
  const js = ts.transpileModule('module.exports = ' + callback.arguments[0].getText(ast) + ';', {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}}).outputText;
  const records = [
    {id:'b',created_at:4,billing_period_end_at:null,token_spend_used_cents:null},
    {id:'a',created_at:4,billing_period_end_at:null,token_spend_used_cents:null},
    {id:'d',created_at:7,billing_period_end_at:50,token_spend_used_cents:20},
    {id:'c',created_at:1,billing_period_end_at:20,token_spend_used_cents:5},
  ];
  const expected = {
    created_at:{asc:'c,a,b,d',desc:'d,a,b,c'},
    billing_end:{asc:'c,d,a,b',desc:'d,c,a,b'},
    token_spend:{asc:'a,b,c,d',desc:'d,c,a,b'},
  };
  let checks = 0;
  for (const sortBy of Object.keys(expected)) for (const sortDirection of ['asc','desc']) {
    for (const currentAccountId of records.map(a=>a.id)) for (const input of [records,[...records].reverse(),[records[2],records[0],records[3],records[1]]]) {
      const context = {module:{exports:null},sortBy,sortDirection,currentAccountId,parseFiniteNumber(value){if(value==null)return null;const n=Number(value);return Number.isFinite(n)?n:null;}};
      vm.runInNewContext(js,context,{timeout:1000});
      const actual=[...input].sort(context.module.exports).map(a=>a.id).join(',');
      if (actual!==expected[sortBy][sortDirection]) throw new Error('Sort regression: '+actual);
      checks++;
    }
  }

  const configPath=path.join(root,'src-tauri/tauri.conf.json');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  config.bundle.targets=['nsis'];
  config.bundle.createUpdaterArtifacts=true;
  config.plugins.updater.pubkey=publicKey.trim();
  // A single private channel with no fallback to the official unpatched binaries.
  config.plugins.updater.endpoints=[`https://github.com/${repository}/releases/latest/download/latest.json`];
  const notesPath=path.join(root,'src/utils/updaterReleaseNotes.ts');
  const notes=replaceOnce(fs.readFileSync(notesPath,'utf8').replace(/\r\n/g,'\n'), 'https://github.com/jlcodes99/cockpit-tools/releases/tag/v', `https://github.com/${repository}/releases/tag/v`);
  const ownNotes=replaceOnce(notes,'https://github.com/jlcodes99/cockpit-tools/releases/latest',`https://github.com/${repository}/releases/latest`);
  // Only write after every compatibility and ordering guard has succeeded.
  fs.writeFileSync(page,source);
  fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
  fs.writeFileSync(notesPath,ownNotes);
  console.log(`Applied stable Zed ordering; ${checks} sort scenarios passed. Update channel: ${repository}`);
  return checks;
}

if(require.main===module){try{customize(path.resolve(process.argv[2]),process.argv[3],process.env.TAURI_SIGNING_PUBLIC_KEY);}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={customize,replaceOnce};
