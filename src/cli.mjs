import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// LaunchAgents start modules through the `current` release symlink, so compare real paths;
// comparing the symlinked argv path with the module path silently skips the command.
export function isEntryPoint(moduleUrl){
  return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(moduleUrl));
}
