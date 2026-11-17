// All gesture / timing thresholds live here. Times in ms, distances in CSS px.
export const CFG = {
  mouse: {
    multiClickMs: 450,        // max gap between clicks to count as double/triple
    multiClickSlopPx: 6,
    wheelLinePx: 16,          // deltaMode=1 (lines) -> px
    wheelPagePx: 700,         // deltaMode=2 (pages) -> px
    wheelGain: 1,
  },
  touch: {
    tapMaxMs: 280,            // press shorter than this = tap
    tapSlopPx: 10,            // movement allowed inside a tap
    doubleTapMs: 320,         // second tap within this = double click (third = triple)
    doubleTapSlopPx: 36,
    longPressMs: 500,         // hold to arm right-click / drag
    dragSlopPx: 6,            // after long-press, moving this far starts a drag
    twoFingerTapMaxMs: 280,
    twoFingerTapSlopPx: 14,
    twoFingerIntentSlopPx: 8, // centroid travel that decides "scroll"
    pinchIntentRatio: 0.06,   // fractional distance change that decides "pinch"
    scrollGain: 1.25,         // Mac px per finger px
    momentum: {
      sampleWindowMs: 90, minVelocity: 0.03, maxVelocity: 6, // px/ms
      decayPerMs: 0.0035,     // v *= exp(-decayPerMs * dt)
    },
    zoom: { min: 1, max: 8 },
    trackpad: {
      baseGain: 1.3,          // cursor px per finger px at low speed (in screen-fraction terms)
      accel: 0.9,             // extra gain per px/ms of finger speed
      maxGain: 5,
      tapDragWindowMs: 350,   // touch again within this after a tap -> press-and-drag
    },
  },
  keyboard: {
    switcherAutoReleaseMs: 7000, // release held Cmd after Cmd+Tab if idle
    stickyLockMs: 400,           // double-tap a sticky modifier within this to lock it
    pasteFallbackMs: 220,        // if no paste event follows Cmd/Ctrl+V, send raw keystroke
    shadowResetIdleMs: 4000,     // clear the on-screen-keyboard buffer after idle
    shadowMaxChars: 120,
    seqGapMs: 6,
  },
  net: { pingMs: 2000, reconnectBaseMs: 500, reconnectMaxMs: 8000, moveMinIntervalMs: 0 },
  ui: { toastMs: 2600, hapticMs: 6, longPressRingMs: 500 },
  video: { statsMs: 1000, maxDecodeQueue: 6 },
};
