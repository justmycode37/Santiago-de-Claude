// First visit on this device: the introduction (onboarding.js) comes before the map and before the location prompt.
// 'onboarding' in localStorage: 'started' until it has been finished, then 'done'. A device that has used the app
// before never sees it. ?intro shows it again, ?intro=0 switches it off (tests, screen recordings).
(function () {
  let show = false;
  try {
    const flag = new URLSearchParams(location.search).get('intro');
    const seen = localStorage.getItem('onboarding');
    if (flag === '0') localStorage.setItem('onboarding', 'done');
    else if (flag !== null || seen === 'started') show = true;
    else if (!seen) {
      const used = ['app-settings', 'app-language', 'lastLocation', 'theme', 'event-preferences'].some((k) => localStorage.getItem(k) !== null);
      localStorage.setItem('onboarding', used ? 'done' : 'started');
      show = !used;
    }
  } catch (e) {} // nothing can be remembered here: better never than on every visit
  if (show) document.documentElement.dataset.onboarding = 'first';
})();
