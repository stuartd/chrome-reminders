(() => {
  // Deliberately conservative: an open tab / pre-join screen is not evidence of joining.
  // English Meet UI is supported. Unknown/localized labels leave reminders enabled.
  function hasJoined() {
    return [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')]
      .some(button => {
        const label = (button.getAttribute('aria-label') || '').trim();
        if (!/^(leave call|leave meeting|hang up)(\s*\(.*\))?$/i.test(label)) return false;
        const style = getComputedStyle(button);
        return !button.disabled && button.getAttribute('aria-disabled') !== 'true'
          && button.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'probe-meet') respond({ joined: hasJoined(), url: location.href });
  });

  let lastJoined = false;
  let lastUrl = '';
  let lastReport = 0;
  function report() {
    const joined = hasJoined();
    // Repeat positive evidence so meetings entering their reminder window are matched too.
    if (joined && (!lastJoined || lastUrl !== location.href || Date.now() - lastReport > 25_000)) {
      lastReport = Date.now();
      chrome.runtime.sendMessage({ type: 'meet-joined' }).catch(() => {});
    }
    lastJoined = joined;
    lastUrl = location.href;
  }
  let pending;
  new MutationObserver(() => {
    if (!pending) pending = setTimeout(() => { pending = null; report(); }, 300);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'disabled', 'aria-disabled', 'style', 'class'] });
  setInterval(report, 30_000);
  report();
})();
