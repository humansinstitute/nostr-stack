import {join} from 'node:path';
export function hostServiceLabel(project:string){if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))throw Error('Invalid installation project');return 'studio.otherstuff.nstack.host.'+project;}
function xml(value:string){return value.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));}
function unit(value:string){if(/[\r\n\0]/.test(value))throw Error('Invalid service path');return '"'+value.replaceAll('%','%%').replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';}
export function renderHostLaunchd(project:string,bun:string,snapshot:string,dockerDirectory:string){
 const label=hostServiceLabel(project),script=join(snapshot,'scripts/nstack-host.js');
 return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(bun)}</string><string>${xml(script)}</string><string>supervise</string><string>${xml(project)}</string></array>
<key>WorkingDirectory</key><string>/var/empty</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dockerDirectory+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(join(snapshot,'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(snapshot,'stderr.log'))}</string></dict></plist>\n`;
}
export function renderHostSystemd(project:string,bun:string,snapshot:string,dockerDirectory:string){
 hostServiceLabel(project);return `[Unit]\nDescription=NStack ${project} host transport helper\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory=/\nExecStart=${[bun,join(snapshot,'scripts/nstack-host.js'),'supervise',project].map(unit).join(' ')}\nEnvironment=${unit('PATH='+dockerDirectory+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
