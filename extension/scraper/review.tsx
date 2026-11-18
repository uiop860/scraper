import type { ScraperPreview } from "./agent";
import type { Spec } from "./spec";
import type { Value } from "./dom";

export type Review = {
  spec: Spec;
  json: string;
  url: string;
  report: ScraperPreview;
};

function SampleValue({ value }: { value: Value }) {
  if (value === null || value === "")
    return <span className="hint">No value found</span>;
  if (typeof value === "string") return <>{value}</>;
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            <SampleValue value={item} />
          </li>
        ))}
      </ul>
    );
  return (
    <dl>
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>
            <SampleValue value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function fieldLabel(name: string) {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

export function ScraperReview({
  review,
  approved,
  pageReviewed = false,
  pageReviewing = false,
  onPageReview,
  disabled,
  onConfirm,
  onChange,
}: {
  review: Review;
  approved: boolean;
  pageReviewed?: boolean;
  pageReviewing?: boolean;
  onPageReview?: () => void;
  disabled: boolean;
  onConfirm: () => void;
  onChange: () => void;
}) {
  return (
    <section className="review-card" aria-labelledby="review-title">
      <h2 id="review-title">Check one example on the page</h2>
      <p>
        Highlight the fields on the first listing. Use ✓ for a correct field and
        ✕ for a wrong one.
      </p>
      <button disabled={disabled} onClick={onPageReview}>
        {pageReviewing
          ? "Waiting for your choices on the page…"
          : pageReviewed
            ? "Highlight example again"
            : "Highlight example on page"}
      </button>
      {review.report.pages
        .filter((page) => page.kind === "detail")
        .map((page) => (
          <div key={page.kind}>
            <h3>
              {page.kind === "detail"
                ? "From an item’s detail page"
                : "From the listing page"}
            </h3>
            {page.samples.slice(0, 1).map((sample, index) => (
              <div className="sample-item" key={index}>
                <span className="hint">Sample {index + 1}</span>
                <dl>
                  {Object.entries(sample).map(([key, value]) => (
                    <div key={key}>
                      <dt>{fieldLabel(key)}</dt>
                      <dd>
                        <SampleValue value={value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        ))}
      <p className="hint">
        {review.spec.detail
          ? "Includes fields from item detail pages. "
          : "Only collects fields from listing pages. "}
        {review.report.coverage.pagination === "tested next page"
          ? "Moving to the next page was tested."
          : review.spec.pagination
            ? "Moving to the next page has not been verified."
            : "Collects this listing page only."}{" "}
        Samples do not verify every item on the site.
      </p>
      <div className="review-actions">
        {review.spec.detail && (
          <button
            disabled={disabled || approved || !pageReviewed}
            onClick={onConfirm}
          >
            {approved ? "Confirmed" : "Detail samples are correct too"}
          </button>
        )}
        <button disabled={disabled} onClick={onChange}>
          I want changes
        </button>
      </div>
      {approved && (
        <p role="status">Ready. Select Run scraper to collect the results.</p>
      )}
    </section>
  );
}
