const fs=require('node:fs');
const cp=require('node:child_process');
function gh(args){const r=cp.spawnSync('gh',args,{encoding:'utf8',shell:false});if(r.status!==0)throw new Error(r.stderr||'GitHub API request failed');return JSON.parse(r.stdout);}
function probeRelease(repo,tag){const p=cp.spawnSync('gh',['api',`repos/${repo}/releases/tags/${tag}`],{encoding:'utf8',shell:false});if(p.status===0)return JSON.parse(p.stdout);if(/404/.test(p.stderr||''))return null;throw new Error('Unable to check release '+tag+': '+p.stderr);}
function nextPatchPrerelease(version,runNumber){const parts=version.split('.').map(Number);if(parts.length!==3||parts.some(n=>!Number.isInteger(n)||n<0))throw new Error('Invalid upstream version');return `${parts[0]}.${parts[1]}.${parts[2]+1}-cockpit.${runNumber}`;}
function main(){
  const upstream='jlcodes99/cockpit-tools';
  const release=gh(['api',`repos/${upstream}/releases/latest`]);
  if(release.draft||release.prerelease||!/^v\d+\.\d+\.\d+$/.test(release.tag_name))throw new Error('Expected a stable official release');
  const upstreamTag=release.tag_name;
  const upstreamVersion=upstreamTag.slice(1);
  const upstreamSha=gh(['api',`repos/${upstream}/commits/${upstreamTag}`]).sha;
  if(!/^[a-f0-9]{40}$/.test(upstreamSha))throw new Error('Invalid upstream commit');

  const repo=process.env.GITHUB_REPOSITORY;
  const currentConfigSha=process.env.GITHUB_SHA;
  const runNumber=process.env.GITHUB_RUN_NUMBER||'1';
  if(!repo||!currentConfigSha)throw new Error('Missing GitHub workflow context');

  const exact=probeRelease(repo,upstreamTag);
  let build=false;
  let version=upstreamVersion;
  let tag=upstreamTag;
  let reason='official version already published with current customization';

  if(!exact||exact.draft){
    build=true;
    reason='official version not yet published on personal channel';
  }else{
    let latest=null;
    const latestProbe=cp.spawnSync('gh',['api',`repos/${repo}/releases/latest`],{encoding:'utf8',shell:false});
    if(latestProbe.status===0)latest=JSON.parse(latestProbe.stdout);
    else if(!/404/.test(latestProbe.stderr||''))throw new Error('Unable to inspect latest personal release: '+latestProbe.stderr);

    if(!latest||latest.target_commitish!==currentConfigSha){
      version=nextPatchPrerelease(upstreamVersion,runNumber);
      tag='v'+version;
      const sameCustom=probeRelease(repo,tag);
      build=!(sameCustom&&!sameCustom.draft);
      reason=build?'customization changed since the last published build':'custom revision already published';
    }
  }

  fs.appendFileSync(process.env.GITHUB_OUTPUT,`build=${build}\ntag=${tag}\nversion=${version}\nupstream_tag=${upstreamTag}\nupstream_version=${upstreamVersion}\nsha=${upstreamSha}\n`);
  fs.writeFileSync('upstream-release.json',JSON.stringify(release,null,2));
  console.log(`${upstreamTag} at ${upstreamSha}; release ${tag}: ${build?'build required':'no build'} (${reason})`);
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
