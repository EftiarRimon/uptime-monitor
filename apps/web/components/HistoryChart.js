import { useState } from "react";

const time = (value) => new Date(value).toLocaleString();

export default function HistoryChart({ series, metric, title, unit, ceiling }) {
  const [active, setActive] = useState(null);
  const values = series
    .map((bucket) => bucket[metric])
    .filter((value) => value !== null);
  const max = ceiling || Math.max(1, ...values) * 1.15;
  const width = 640;
  const height = 210;
  const left = 54;
  const bottom = 176;
  const plotWidth = width - left - 16;
  const plotHeight = bottom - 18;
  const step = plotWidth / series.length;
  const x = (index) => left + step * (index + 0.5);
  const y = (value) => bottom - (value / max) * plotHeight;
  const segments = [];
  let segment = [];
  series.forEach((bucket, index) => {
    if (bucket[metric] === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(`${x(index)},${y(bucket[metric])}`);
  });
  if (segment.length) segments.push(segment);
  const selected = active === null ? null : series[active];
  const describe = (bucket) =>
    `${time(bucket.bucketStart)}: ${bucket[metric] === null ? "No data" : bucket[metric].toFixed(1) + unit}, ${bucket.totalChecks} checks`;

  return (
    <section className="card history-chart">
      <h2>{title}</h2>
      {values.length === 0 && (
        <p className="hint">
          {metric === "avgLatencyMs"
            ? "No successful checks in this period."
            : "No checks in this period."}
        </p>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={title}
        onMouseLeave={() => setActive(null)}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1={left}
              x2={width - 16}
              y1={y(max * fraction)}
              y2={y(max * fraction)}
              className="chart-grid"
            />
            <text x={left - 8} y={y(max * fraction) + 4} textAnchor="end">
              {Math.round(max * fraction)}
              {unit}
            </text>
          </g>
        ))}
        {metric === "avgLatencyMs" &&
          segments.map((points, index) => (
            <polyline
              key={index}
              points={points.join(" ")}
              className="latency-line"
            />
          ))}
        {series.map((bucket, index) => (
          <g
            key={bucket.bucketStart}
            tabIndex={0}
            role="img"
            aria-label={describe(bucket)}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
            onMouseEnter={() => setActive(index)}
            className="chart-point"
          >
            <title>{describe(bucket)}</title>
            <rect
              x={left + index * step}
              y={18}
              width={step}
              height={plotHeight}
              fill="transparent"
            />
            {metric === "uptimePercent" ? (
              <rect
                x={left + index * step + 2}
                y={bucket[metric] === null ? bottom - 3 : y(bucket[metric])}
                width={Math.max(1, step - 4)}
                height={
                  bucket[metric] === null
                    ? 3
                    : Math.max(3, bottom - y(bucket[metric]))
                }
                className={
                  bucket[metric] === null
                    ? "chart-missing"
                    : bucket[metric] < 100
                      ? "chart-degraded"
                      : "chart-up"
                }
              />
            ) : (
              bucket[metric] !== null && (
                <circle
                  cx={x(index)}
                  cy={y(bucket[metric])}
                  r={active === index ? 5 : 3}
                  className="latency-point"
                />
              )
            )}
          </g>
        ))}
        <text x={left} y={height - 8}>
          {new Date(series[0].bucketStart).toLocaleDateString()}
        </text>
        <text x={width - 16} y={height - 8} textAnchor="end">
          {new Date(series[series.length - 1].bucketStart).toLocaleDateString()}
        </text>
      </svg>
      <p className="chart-caption">
        {selected
          ? describe(selected)
          : "Hover or focus a time bucket to inspect it. Gaps mean no data."}
      </p>
    </section>
  );
}
