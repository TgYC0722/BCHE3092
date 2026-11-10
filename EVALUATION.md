# Evaluation

## Performance & Accuracy

- **Successes.** The AI correctly configured a self-hosted webR session (R 4.6.0, webR 0.6.1) and ran R's `nls()` independently on every compound. All 6/6 curves converged, each IC50 came back with a 95% profile-likelihood confidence interval, and the exact R program is printed on the page for checking.

- **Biochemical results** (simulated demo data; true IC50 in brackets):
  - Imatinib 1.18 nM (1.2), Dasatinib 4.31 (4.5), Nilotinib 16.1 (16), Bosutinib 57.2 (55), Ponatinib 172 (180), Gefitinib 388 (320).
  - The potency ranking matches the true order, and five of the six IC50 values are within ~5% of the truth; the noisiest compound (Gefitinib) is within ~21% because its curve does not fully plateau in the tested range.
  - The 95% CIs are asymmetric after the 10^ back-transform (e.g. Gefitinib 305–541 nM), and Bosutinib's residual standard error (6.08) is flagged as "residuals too large" instead of being hidden.

- **Failures & fixes.**
  - The first `confint()` extraction crashed because it returns a vector, not a matrix; fixed by reading the two values directly.
  - Plain Gauss–Newton `nls()` failed with "singular gradient" on one clean curve, and profile CIs failed on two compounds; switching to `algorithm = "port"` with wide bounds fixed all six.
  - The initial build loaded R from the webR CDN, and an early version did not compare the rows R used with the file rows; both were corrected (self-hosted `public/webr/`, plus a row-consistency warning).

- **Not done / limits.** No weighted fitting, outlier removal, global/shared fits or automatic unit checks. A profile CI can still fail on a weakly determined curve (shown as "—" with R's error message), and the 4PL model assumes a monotonic sigmoid.
