const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function main(){
  const app=path.resolve(process.argv[2]);const repo=process.env.GITHUB_REPOSITORY;const version=process.env.RELEASE_VERSION;
  const upstream=JSON.parse(fs.readFileSync('upstream-release.json','utf8'));
  if(!/^\d+\.\d+\.\d+$/.test(version)||!repo||upstream.tag_name!=='v'+version)throw new Error('Release metadata mismatch');
  const pkg=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
  if(pkg.version!==version)throw new Error('Source/package version mismatch');
  const dir=path.join(app,'target/release/bundle/nsis');
  const installers=fs.readdirSync(dir).filter(n=>n.endsWith('-setup.exe'));
  if(installers.length!==1)throw new Error('Expected exactly one NSIS installer');
  const original=path.join(dir,installers[0]);const signature=fs.readFileSync(original+'.sig','utf8').trim();
  if(!signature)throw new Error('Missing update signature');
  const name=`Cockpit.Tools_${version}_x64-setup.exe`;
  fs.mkdirSync('out',{recursive:true});fs.copyFileSync(original,path.join('out',name));fs.writeFileSync(path.join('out',name+'.sig'),signature+'\n');
  const notes='Zed 账号顺序固定版：切换当前账号不置顶；同值账号保持固定顺序。\n\n基于官方 '+upstream.tag_name+'\n\n'+(upstream.body||'');
  fs.writeFileSync('release-notes.md',notes+'\n');
  const target={url:`https://github.com/${repo}/releases/download/v${version}/${name}`,signature};
  const manifest={version,notes,pub_date:new Date().toISOString(),html_url:`https://github.com/${repo}/releases/tag/v${version}`,platforms:{'windows-x86_64':target,'windows-x86_64-nsis':target}};
  fs.writeFileSync('out/latest.json',JSON.stringify(manifest,null,2)+'\n');
  const source=require(path.join(app,'scripts/release/build_windows_portable.cjs'));
  source.buildWindowsPortableArchive({releaseDir:path.join(app,'target/release'),outputDir:path.resolve('out'),version});
  fs.writeFileSync('out/BUILD-INFO.txt',`upstream=${upstream.html_url}\nupstream_commit=${process.env.UPSTREAM_SHA}\nbuild_config=${repo}@${process.env.GITHUB_SHA}\n`);
  fs.writeFileSync('out/SHA256SUMS.txt',fs.readdirSync('out').sort().filter(n=>n!=='SHA256SUMS.txt').map(n=>crypto.createHash('sha256').update(fs.readFileSync(path.join('out',n))).digest('hex')+'  '+n).join('\n')+'\n');
  console.log('Staged signed installer, portable archive and personal updater manifest.');
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
