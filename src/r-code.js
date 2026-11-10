/**
 * Builds the R program that is actually executed inside webR.
 *
 * The uploaded CSV is passed to R as text: the browser URL-encodes it, and R
 * decodes it with URLdecode() before read.csv(text = ...). This keeps the data
 * transfer to plain ASCII and avoids any quoting/escaping problems.
 *
 * The generated source is shown verbatim in the "R code" panel, so it only uses
 * base R and the bundled stats package (nls, confint, predict).
 */

const FIELD_SEPARATOR = '\x1f';

/**
 * @param {string} csvText raw uploaded CSV (BOM already stripped)
 * @returns {string} R source code
 */
export function buildRCode(csvText) {
  const encoded = encodeURIComponent(csvText);

  return `# ============================================================
#  Potency Ranker - 4PL dose-response fitting
#  Runs locally in the browser via webR (base R + stats only).
#  One curve per compound; the model is fitted on log10(conc).
# ============================================================

# 1. Read the uploaded CSV (URL-encoded text, ${encoded.length} chars).
csv_text <- URLdecode("${encoded}")

dose_data <- read.csv(
  text = csv_text,
  stringsAsFactors = FALSE,
  check.names = FALSE,
  strip.white = TRUE,
  na.strings = c("", "NA", "NaN", "N/A")
)

# 2. Keep the four expected columns and drop incomplete rows.
#    (The page's data self-check counts and lists every skipped row.)
dose_data <- dose_data[, c("compound", "conc_nM", "response_pct", "replicate")]
dose_data <- dose_data[complete.cases(dose_data), ]
dose_data$compound <- trimws(as.character(dose_data$compound))

# Always work on log10(concentration), never on raw linear nM.
dose_data$log10_conc <- log10(dose_data$conc_nM)
dose_data <- dose_data[is.finite(dose_data$log10_conc), ]

# 3. Helpers -------------------------------------------------
SEP <- "\\x1f"

fmt <- function(x) {
  if (length(x) == 0 || is.null(x) || is.na(x)) "NA" else sprintf("%.10g", x)
}

fit_one <- function(df) {
  df <- df[order(df$log10_conc), ]
  n <- nrow(df)
  n_conc <- length(unique(df$log10_conc))

  # A 4-parameter curve needs at least 4 different concentrations.
  if (n < 4 || n_conc < 4) {
    return(list(ok = FALSE, n = n, msg = sprintf(
      "有效数据不足：n = %d，不同浓度点 = %d（4PL 至少需要 4 个不同浓度）", n, n_conc)))
  }
  if (length(unique(df$response_pct)) < 2) {
    return(list(ok = FALSE, n = n, msg = "该化合物所有响应值相同，无法估计参数"))
  }

  # Initial values: bottom = min(response), top = max(response),
  # logIC50 = median(log10(conc)), hill = 1.
  start <- list(
    bottom  = min(df$response_pct),
    top     = max(df$response_pct),
    logIC50 = median(df$log10_conc),
    hill    = 1
  )

  # The PORT algorithm with deliberately wide bounds is used: the bounds are far
  # outside any plausible estimate and are only there to keep the fitting steps
  # numerically stable (plain Gauss-Newton can stall on near-perfect data, which
  # also breaks profile-likelihood confidence intervals).
  lower <- c(bottom = -1e4, top = -1e4, logIC50 = -30, hill = -50)
  upper <- c(bottom =  1e4, top =  1e4, logIC50 =  30, hill =  50)

  warns <- character(0)
  fit <- NULL
  fit_err <- NULL

  tryCatch(
    withCallingHandlers(
      {
        fit <- nls(
          response_pct ~ bottom + (top - bottom) / (1 + 10^((logIC50 - log10_conc) * hill)),
          data = df,
          start = start,
          algorithm = "port",
          lower = lower,
          upper = upper,
          control = nls.control(maxiter = 1000, tol = 1e-7, minFactor = 1e-6,
                                warnOnly = FALSE)
        )
      },
      warning = function(w) {
        warns <<- c(warns, conditionMessage(w))
        invokeRestart("muffleWarning")
      }
    ),
    error = function(e) fit_err <<- conditionMessage(e)
  )

  if (is.null(fit)) {
    return(list(ok = FALSE, n = n, msg = paste0("nls() 报错：", fit_err)))
  }

  cf <- coef(fit)

  # Report top as the upper asymptote. A decreasing curve can be fitted with a
  # positive hill and top < bottom; swapping the two and negating hill describes
  # exactly the same curve but is easier to read.
  top_value <- cf[["top"]]
  bottom_value <- cf[["bottom"]]
  hill_value <- cf[["hill"]]
  if (top_value < bottom_value) {
    swap <- top_value
    top_value <- bottom_value
    bottom_value <- swap
    hill_value <- -hill_value
  }

  # Residual standard error, reported next to the estimates.
  rse <- NA_real_
  if (df.residual(fit) > 0) {
    rse <- sqrt(sum(residuals(fit)^2) / df.residual(fit))
  } else {
    warns <- c(warns, "残差自由度为 0，无法估计残差标准误")
  }

  # 95% profile-likelihood CI for logIC50, then 10^ back to nM.
  # The transformed interval is asymmetric: both ends are kept as-is.
  ci <- suppressMessages(tryCatch(
    confint(fit, "logIC50", level = 0.95),
    error = function(e) {
      warns <<- c(warns, paste0("confint() 失败：", conditionMessage(e)))
      NULL
    }
  ))
  ci_vals <- if (is.null(ci)) c(NA_real_, NA_real_) else as.numeric(ci)[1:2]
  if (length(ci_vals) < 2 || anyNA(ci_vals)) {
    ci_vals <- c(NA_real_, NA_real_)
  }

  # Fitted curve for plotting, on the log10 concentration scale.
  pred_x <- seq(min(df$log10_conc) - 0.25, max(df$log10_conc) + 0.25, length.out = 121)
  pred_y <- predict(fit, newdata = data.frame(log10_conc = pred_x))

  list(
    ok = TRUE,
    n = n,
    ic50 = 10^cf[["logIC50"]],
    ci_low = 10^ci_vals[1],
    ci_high = 10^ci_vals[2],
    hill = hill_value,
    top = top_value,
    bottom = bottom_value,
    rse = rse,
    log_ic50 = cf[["logIC50"]],
    msg = paste(unique(warns), collapse = " | "),
    pred_x = pred_x,
    pred_y = pred_y
  )
}

# 4. Fit each compound separately -----------------------------
compounds <- unique(dose_data$compound)
out <- character(0)

for (cmp in compounds) {
  df <- dose_data[dose_data$compound == cmp, , drop = FALSE]
  r <- fit_one(df)

  if (isTRUE(r$ok)) {
    curve <- paste(sprintf("%.6f:%.6f", r$pred_x, r$pred_y), collapse = ";")
    out <- c(out, paste(
      cmp, "ok",
      fmt(r$ic50), fmt(r$ci_low), fmt(r$ci_high), fmt(r$hill),
      fmt(r$top), fmt(r$bottom), r$n, fmt(r$rse), fmt(r$log_ic50),
      gsub("[\\r\\n\\x1f]", " ", r$msg), curve,
      sep = SEP
    ))
  } else {
    out <- c(out, paste(
      cmp, "fail",
      "NA", "NA", "NA", "NA", "NA", "NA", r$n, "NA", "NA",
      gsub("[\\r\\n\\x1f]", " ", r$msg), "",
      sep = SEP
    ))
  }
}

out
`;
}

/**
 * Parse the character vector returned by R. One record per compound, fields
 * joined with \x1f:
 * compound, status, ic50, ci_low, ci_high, hill, top, bottom, n, rse,
 * log_ic50, message, curve ("x:y;x:y;...", x = log10 concentration).
 *
 * @param {string[]} lines
 */
export function parseFitLines(lines) {
  const toNumber = (raw) => {
    if (raw === undefined || raw === null || raw === '' || raw === 'NA') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  return lines
    .filter((line) => typeof line === 'string' && line.length > 0)
    .map((line) => {
      const parts = line.split(FIELD_SEPARATOR);
      while (parts.length < 13) parts.push('');
      const [compound, status, ic50, ciLow, ciHigh, hill, top, bottom, n, rse, logIC50, message, curve] =
        parts;

      const points = curve
        ? curve
            .split(';')
            .filter(Boolean)
            .map((pair) => pair.split(':').map(Number))
            .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
        : [];

      return {
        compound,
        ok: status === 'ok',
        ic50: toNumber(ic50),
        ciLow: toNumber(ciLow),
        ciHigh: toNumber(ciHigh),
        hill: toNumber(hill),
        top: toNumber(top),
        bottom: toNumber(bottom),
        n: toNumber(n) ?? 0,
        rse: toNumber(rse),
        logIC50: toNumber(logIC50),
        message: message.trim(),
        curve: points,
      };
    });
}

export { FIELD_SEPARATOR };
