// The page's script could not be loaded (index.html: <script type="module" onerror="scriptFailed(this.src)">): its
// file, or one of the files it imports (the page names them all: <link rel="modulepreload">). If one of them is
// gone, the site has been updated since this copy of the page was cached: the files are named by their content and
// each deploy replaces them all, so a page cached before then asks for files that are no longer there. A reload
// brings the new page (a browser asks for the page itself again on a reload). Once for each file that was missing,
// in case it does not: a later deploy in the same tab is recovered from too. Without a connection there is nothing
// to do here (on a first visit the cover goes anyway: early.ts).
(function () {
  window.scriptFailed = (src) => {
    const files = [src, ...[...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => (l as HTMLLinkElement).href)];
    Promise.all(files.map((f) => fetch(f, { method: 'HEAD', cache: 'no-store' }).then((r) => (r.status === 404 || r.status === 410 ? f : null), () => null)))
      .then((gone) => {
        const missing = gone.find(Boolean);
        if (!missing) return;
        try {
          const key = 'reloaded-for ' + missing;
          if (sessionStorage.getItem(key)) return;
          sessionStorage.setItem(key, '1');
        } catch (e) { return; } // nothing can be remembered: better no reload than one after another
        location.reload();
      });
  };
})();
