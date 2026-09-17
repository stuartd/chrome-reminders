import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../extension/meet.js', import.meta.url), 'utf8');
function detector(buttons) {
  let listener;
  const reports = [];
  runInNewContext(source, {
    document: { documentElement: {}, querySelectorAll: () => buttons },
    getComputedStyle: button => ({ visibility: button.hidden ? 'hidden' : 'visible', display: 'block' }),
    location: { href: 'https://meet.google.com/abc-defg-hij' },
    MutationObserver: class { observe() {} },
    setInterval() {}, setTimeout() {},
    chrome: { runtime: {
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => reports.push(message)
    } }
  });
  let reply;
  listener({ type: 'probe-meet' }, {}, value => { reply = value; });
  return { reply, reports };
}
const button = (label, patch = {}) => ({ getAttribute: key => key === 'aria-label' ? label : null, getClientRects: () => [{}], disabled: false, ...patch });

test('Meet waiting rooms, hidden hang-up controls and disabled controls do not count as joined', () => {
  for (const buttons of [[], [button('Join now')], [button('Ask to join')], [button('Leave call', { hidden: true })], [button('Leave call', { disabled: true })], [button('Leave call', { getClientRects: () => [] })]]) {
    const result = detector(buttons);
    assert.equal(result.reply.joined, false);
    assert.equal(result.reports.length, 0);
  }
});

test('a visible active-call control reports joining, including shortcut labels', () => {
  for (const label of ['Leave call', 'Leave meeting', 'Hang up', 'Leave call (Ctrl + Alt + H)']) {
    const result = detector([button(label)]);
    assert.equal(result.reply.joined, true);
    assert.equal(result.reports[0].type, 'meet-joined');
  }
});
