const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function main(){
  const app=path.resolve(process.argv[2]);const repo=process.env.GITHUB_REPOSITORY;const version=process.env.RELEASE_VERSION;
  const upstreamVersion=process.env.UPSTREAM_VERSION;const upstreamTag=process.env.UPSTREAM_TAG;const configSha=process.env.CONFIG_SHA;
  const upstream=JSON.parse(fs.readFileSync('upstream-release.json','utf8'));
  if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)||!repo)throw new Error('Invalid customized release metadata');
  if(!/^\d+\.\d+\.\d+$/.test(upstreamVersion||'')||upstreamTag!=='v'+upstreamVersion||upstream.tag_name!==upstreamTag)throw new Error('Upstream release metadata mismatch');
  if(!/^[a-f0-9]{40}$/.test(configSha||''))throw new Error('Invalid build configuration commit');
  const pkg=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
  if(pkg.version!==version)throw new Error('Source/package version mismatch');
  const dir=path.join(app,'target/release/bundle/nsis');
  const installers=fs.readdirSync(dir).filter(n=>n.endsWith('-setup.exe'));
  if(installers.length!==1)throw new Error('Expected exactly one NSIS installer');
  const original=path.join(dir,installers[0]);const signature=fs.readFileSync(original+'.sig','utf8').trim();
  if(!signature)throw new Error('Missing update signature');
  const name=`Cockpit.Tools_${version}_x64-setup.exe`;
  fs.mkdirSync('out',{recursive:true});fs.copyFileSync(original,path.join('out',name));fs.writeFileSync(path.join('out',name+'.sig'),signature+'\n');
  const notes='Zed 定制版：切换当前账号不置顶；修正 Student Hosted AI 可用性检测，刷新时通过最多 1 个输出 token 的极小网关探针识别 token_spend_limit_reached，不计算美元余额。\n\n基于官方 '+upstreamTag+'\n\n'+(upstream.body||'');
  fs.writeFileSync('release-notes.md',notes+'\n');
  const target={url:`https://github.com/${repo}/releases/download/v${version}/${name}`,signature};
  const manifest={version,notes,pub_date:new Date().toISOString(),html_url:`https://github.com/${repo}/releases/tag/v${version}`,platforms:{'windows-x86_64':target,'windows-x86_64-nsis':target}};
  fs.writeFileSync('out/latest.json',JSON.stringify(manifest,null,2)+'\n');
  const source=require(path.join(app,'scripts/release/build_windows_portable.cjs'));
  source.buildWindowsPortableArchive({releaseDir:path.join(app,'target/release'),outputDir:path.resolve('out'),version});
  fs.writeFileSync('out/BUILD-INFO.txt',`upstream=${upstream.html_url}\nupstream_tag=${upstreamTag}\nupstream_commit=${process.env.UPSTREAM_SHA}\ncustom_version=${version}\nbuild_config=${configSha}\n`);
  fs.writeFileSync('out/SHA256SUMS.txt',fs.readdirSync('out').sort().filter(n=>n!=='SHA256SUMS.txt').map(n=>crypto.createHash('sha256').update(fs.readFileSync(path.join('out',n))).digest('hex')+'  '+n).join('\n')+'\n');
  console.log('Staged signed installer, portable archive and personal updater manifest.');
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
