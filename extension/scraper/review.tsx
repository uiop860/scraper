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
  disabled,
  onConfirm,
  onChange,
}: {
  review: Review;
  approved: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onChange: () => void;
}) {
  return (
    <section className="review-card" aria-labelledby="review-title">
      <h2 id="review-title">Is this the data you wanted?</h2>
      <p>Check these scraped samples before running the full scraper.</p>
      {review.report.pages
        .filter((page) => page.kind === "list" || page.kind === "detail")
        .map((page) => (
          <div key={`${page.kind}:${page.url}`}>
            <h3>
              {page.kind === "detail"
                ? "From an item’s detail page"
                : "From the listing page"}
            </h3>
            {page.samples.slice(0, 2).map((sample, index) => (
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
        <button disabled={disabled || approved} onClick={onConfirm}>
          {approved ? "Confirmed" : "Yes, this is right"}
        </button>
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
