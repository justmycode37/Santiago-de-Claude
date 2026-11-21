const film = document.getElementById('film') as HTMLVideoElement;
async function restartFilm() {
  // Start a fresh media session after navigation, including a cached Back visit.
  film.src = 'santiago.mp4';
  film.load();
  film.currentTime = 0;
  film.muted = false;
  try {
    await film.play();
  } catch (error) {
    if ((error as Error).name !== 'NotAllowedError') return;
    film.muted = true;
    await film.play().catch(() => {});
  }
}
restartFilm();
window.addEventListener('pageshow', event => {
  if (event.persisted) restartFilm();
});

function togglePlayback() {
  if (!film.muted && !film.paused && !film.ended) {
    film.pause();
    return;
  }
  film.muted = false;
  if (film.ended) film.currentTime = 0;
  const playback = film.play();
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  playback.catch(() => {});
}
document.addEventListener('keydown', event => {
  if (event.code === 'Space' || event.key === ' ') {
    event.preventDefault();
    if (!event.repeat) togglePlayback();
  }
});
film.addEventListener('click', togglePlayback);
