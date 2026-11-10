# Evaluation

- **Successes.** The AI correctly configured a self-hosted webR session (R 4.6.0, webR 0.6.1) and ran R's `nls()` independently on every compound. All 6/6 curves converged, each IC50 came back with a 95% profile-likelihood confidence interval, and the exact R program is printed on the page for checking.

- **Failures & fixes.**
  - The first `confint()` extraction crashed because it returns a vector, not a matrix; fixed by reading the two values directly.
  - Plain Gauss–Newton `nls()` failed with "singular gradient" on one clean curve, and profile CIs failed on two compounds; switching to `algorithm = "port"` with wide bounds fixed all six.
  - The initial build loaded R from the webR CDN, and an early version did not compare the rows R used with the file rows; both were corrected (self-hosted `public/webr/`, plus a row-consistency warning).
