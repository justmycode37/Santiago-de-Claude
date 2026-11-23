// The page's script could not be loaded (index.html: <script type="module" onerror="scriptFailed(this.src)">). If
// its file is gone, the site has been updated since this copy of the page was cached: the files are named by their
// content and each deploy replaces them all, so a page cached before then asks for files that are no longer there.
// A reload brings the new page (a browser asks for the page itself again on a reload); once, in case it does not.
// Without a connection there is nothing to do here (on a first visit the cover goes anyway: early.ts).
(function () {
  window.scriptFailed = (src) => {
    fetch(src, { method: 'HEAD', cache: 'no-store' }).then((res) => {
      if (res.status !== 404 && res.status !== 410) return;
      try {
        if (sessionStorage.getItem('reloaded-for-update') === location.href) return;
        sessionStorage.setItem('reloaded-for-update', location.href);
      } catch (e) { return; } // nothing can be remembered: better no reload than one after another
      location.reload();
    }, () => {});
  };
})();
