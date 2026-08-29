// Makes the browser/device Back button always return to a known page
// (the Ward Charts home, index.html), no matter how the current page
// was reached — a direct link, a bookmark, a refresh, or several pages
// of in-app navigation.
//
// How it works: we push one extra history entry for the current page,
// then listen for popstate (fired on Back/Forward). The first Back
// press consumes that extra entry and lands us in this handler instead
// of wherever browser history would naturally have gone, so we can
// force the navigation to targetUrl ourselves.
export function lockBackTo(targetUrl) {
  try {
    history.pushState({ __backGuard: true }, '', location.href);
  } catch (e) { /* ignore (e.g. sandboxed preview) */ }

  window.addEventListener('popstate', () => {
    window.location.replace(targetUrl);
  });
}
