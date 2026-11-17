import { execFile } from 'node:child_process';

/** Mac notification (best effort). Text is passed as an argv item to avoid any AppleScript injection. */
export function notify(title, message) {
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
  execFile('/usr/bin/osascript', ['-e', script, String(title).slice(0, 80), String(message).slice(0, 200)], () => {});
}
