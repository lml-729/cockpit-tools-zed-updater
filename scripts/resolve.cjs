const fs=require('node:fs');
const cp=require('node:child_process');
function gh(args){const r=cp.spawnSync('gh',args,{encoding:'utf8',shell:false});if(r.status!==0)throw new Error(r.stderr||'GitHub API request failed');return JSON.parse(r.stdout);}
function main(){
  const upstream='jlcodes99/cockpit-tools';
  const release=gh(['api',`repos/${upstream}/releases/latest`]);
  if(release.draft||release.prerelease||!/^v\d+\.\d+\.\d+$/.test(release.tag_name))throw new Error('Expected a stable official release');
  const tag=release.tag_name;
  const sha=gh(['api',`repos/${upstream}/commits/${tag}`]).sha;
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Invalid upstream commit');
  const repo=process.env.GITHUB_REPOSITORY;
  let existing=null;
  const probe=cp.spawnSync('gh',['api',`repos/${repo}/releases/tags/${tag}`],{encoding:'utf8',shell:false});
  if(probe.status===0)existing=JSON.parse(probe.stdout);
  else if(!/404/.test(probe.stderr))throw new Error('Unable to check previously published version: '+probe.stderr);
  const build=!(existing&&!existing.draft);
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`build=${build}\ntag=${tag}\nversion=${tag.slice(1)}\nsha=${sha}\n`);
  fs.writeFileSync('upstream-release.json',JSON.stringify(release,null,2));
  console.log(`${tag} at ${sha}: ${build?'build required':'already published'}`);
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
