// Device detection for the camera-vs-upload photo control (per spec).
export const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 &&
    window.matchMedia('(pointer: coarse)').matches);
