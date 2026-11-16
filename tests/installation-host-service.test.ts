import {test,expect} from 'bun:test';import {renderHostLaunchd,renderHostSystemd,hostServiceLabel} from '../src/installation/host-service';
test('durable host runner is exact project, immutable snapshot and minimal nonsecret environment',()=>{
 const plist=renderHostLaunchd('fixture','/opt/bun','/safe/source & snapshot','/opt/docker');
 expect(plist).toContain('studio.otherstuff.nstack.host.fixture');expect(plist).toContain('source &amp; snapshot/scripts/nstack-host.js');expect(plist).toContain('<key>RunAtLoad</key><true/>');expect(plist).toContain('<key>KeepAlive</key><true/>');expect(plist).not.toContain('NSEC');
 const unit=renderHostSystemd('fixture','/opt/bun','/safe/source % snapshot','/opt/docker');expect(unit).toContain('Restart=always');expect(unit).toContain('source %% snapshot/scripts/nstack-host.js');expect(unit).toContain('WantedBy=default.target');
 expect(()=>hostServiceLabel('../other')).toThrow();expect(()=>renderHostSystemd('fixture','/bin/bun\nExecStart=bad','/safe','/bin')).toThrow();
});
