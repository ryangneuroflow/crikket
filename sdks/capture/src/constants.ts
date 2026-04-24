export const DEFAULT_ENDPOINT = "https://api.crikket.io"
export const DEFAULT_SUBMIT_PATH = "/api/embed/bug-reports"
export const DEFAULT_Z_INDEX = 2_147_483_640

// Ring-buffer retention. The collector is installed at SDK bootstrap and
// continuously buffers console/network/action events so that screenshot and
// video captures can include context from before the user triggered the
// capture. Age must be strictly >= the longest lookback window below, with
// some headroom so a slow capture trigger doesn't trim the edges.
export const MAX_RECENT_EVENT_AGE_MS = 75_000
// 1000 ≈ ~16/s for the full 60s window, which comfortably covers a noisy app
// (polling queries + Powertools-style request logging + routine user actions)
// without evicting the earliest — and most diagnostically valuable — events.
export const MAX_RECENT_EVENT_COUNT = 1000

// Captures reach back into the ring buffer by this many ms when a session
// starts. 60s is long enough to include the API error or console message
// that drove the user to open the widget in the first place.
export const SCREENSHOT_LOOKBACK_MS = 60_000
export const VIDEO_LOOKBACK_MS = 60_000

export const TRAILING_SLASHES_REGEX = /\/+$/
