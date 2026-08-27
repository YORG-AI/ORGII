/**
 * a2uiElements — native React renderers for every A2UI element type.
 *
 * This is the single source of truth for element rendering. Both
 * CanvasInlineCard (A2UIRenderer) and WorkStation/Canvas consume this module
 * instead of maintaining separate HTML-string builders.
 *
 * Security: `type="html"` elements are sanitized with DOMPurify before being
 * passed to `dangerouslySetInnerHTML`. All other string content is rendered
 * as text nodes — React handles escaping automatically.
 */
import DOMPurify from "dompurify";
import React, { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Form from "@src/components/Form";
import Image from "@src/components/Image";
import Input from "@src/components/Input";
import Select from "@src/components/Select";

import { useA2UIAction } from "./A2UIActionContext";
import type {
  A2UIButton,
  A2UIChart,
  A2UICode,
  A2UIElement,
  A2UIForm,
  A2UIHeading,
  A2UIHtml,
  A2UIImage,
  A2UIList,
  A2UITable,
  A2UIText,
} from "./types";

// ─── style helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a raw CSS text string ("color:red;font-weight:bold") into a React
 * inline-style object. Unknown or malformed declarations are silently skipped.
 * React only accepts camelCased property names; this handles the common subset
 * used by A2UI elements.
 */
function cssTextToStyle(cssText: string): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const decl of cssText.split(";")) {
    const colonIdx = decl.indexOf(":");
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim();
    const value = decl.slice(colonIdx + 1).trim();
    if (!prop || !value) continue;
    // Convert kebab-case to camelCase
    const camel = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    style[camel] = value;
  }
  return style as React.CSSProperties;
}

// ─── individual element renderers ──────────────────────────────────────────────

const HeadingEl: React.FC<{ el: A2UIHeading }> = ({ el }) => (
  <h2
    className="mb-2 text-[1.05em] font-semibold text-text-1"
    style={el.style ? cssTextToStyle(el.style) : undefined}
  >
    {el.content ?? ""}
  </h2>
);

const TextEl: React.FC<{ el: A2UIText }> = ({ el }) => (
  <p
    className="mb-2.5 text-text-2"
    style={el.style ? cssTextToStyle(el.style) : undefined}
  >
    {el.content ?? ""}
  </p>
);

const CodeEl: React.FC<{ el: A2UICode }> = ({ el }) => (
  <pre
    className="mb-2.5 overflow-x-auto rounded-md border border-border-1 bg-fill-1 p-3 font-mono text-[0.8125em] text-text-2"
    style={el.style ? cssTextToStyle(el.style) : undefined}
  >
    <code>{el.content ?? ""}</code>
  </pre>
);

const HtmlEl: React.FC<{ el: A2UIHtml }> = ({ el }) => {
  const safe = DOMPurify.sanitize(el.content ?? "");
  return (
    <div
      className="a2ui-html mb-2.5"
      style={el.style ? cssTextToStyle(el.style) : undefined}
      // DOMPurify-sanitized HTML from trusted agent context
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
};

const ImageEl: React.FC<{ el: A2UIImage }> = ({ el }) => (
  <Image
    src={el.content ?? ""}
    className="mb-2.5 max-w-full rounded"
    style={el.style ? cssTextToStyle(el.style) : undefined}
    alt=""
  />
);

const ButtonEl: React.FC<{ el: A2UIButton }> = ({ el }) => {
  const onAction = useA2UIAction();
  return (
    <Button
      variant="primary"
      appearance="outline"
      className="my-1"
      style={el.style ? cssTextToStyle(el.style) : undefined}
      onClick={() => {
        if (el.actionId) onAction(el.actionId);
      }}
    >
      {el.content ?? ""}
    </Button>
  );
};

const DividerEl: React.FC = () => (
  <hr className="my-3.5 border-0 border-t border-border-1" />
);

const ListEl: React.FC<{ el: A2UIList }> = ({ el }) => (
  <ul
    className="mb-2.5 list-disc pl-5 text-text-2"
    style={el.style ? cssTextToStyle(el.style) : undefined}
  >
    {(el.items ?? []).map((item, i) => (
      <li key={i} className="mb-1">
        {item}
      </li>
    ))}
  </ul>
);

const TableEl: React.FC<{ el: A2UITable }> = ({ el }) => (
  <div className="mb-2.5 overflow-x-auto rounded-md border border-border-1">
    <table className="w-full border-collapse text-[0.8125em]">
      <thead>
        <tr className="bg-fill-2">
          {el.headers.map((h, i) => (
            <th
              key={i}
              className="border-b border-border-1 px-3 py-2 text-left font-medium text-text-1"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {el.rows.map((row, ri) => (
          <tr key={ri} className={ri % 2 === 0 ? "bg-bg-2" : "bg-fill-1"}>
            {row.map((cell, ci) => (
              <td
                key={ci}
                className="border-b border-border-1/50 px-3 py-2 text-text-2"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const CHART_COLORS = [
  "var(--color-primary-6)",
  "var(--color-success-6)",
  "var(--color-warning-6)",
  "var(--color-danger-6)",
  "var(--color-primary-4)",
  "var(--color-text-3)",
];

const ChartEl: React.FC<{ el: A2UIChart }> = ({ el }) => {
  const { chartType, data, title } = el;

  // Transform to recharts format: [{ label: "Jan", "Dataset A": 10, ... }]
  const chartData = data.labels.map((label, i) => {
    const point: Record<string, string | number> = { label };
    for (const ds of data.datasets) {
      point[ds.label] = ds.values[i] ?? 0;
    }
    return point;
  });

  const ChartComponent = chartType === "line" ? LineChart : BarChart;

  return (
    <div className="mb-2.5">
      {title && (
        <p className="mb-1.5 text-xs font-medium text-text-2">{title}</p>
      )}
      <ResponsiveContainer width="100%" height={200}>
        <ChartComponent data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-1)" />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-text-3)", fontSize: 11 }}
            axisLine={{ stroke: "var(--color-border-2)" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "var(--color-text-3)", fontSize: 11 }}
            axisLine={{ stroke: "var(--color-border-2)" }}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-bg-2)",
              border: "1px solid var(--color-border-1)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--color-text-1)",
            }}
          />
          <Legend
            wrapperStyle={{
              fontSize: 11,
              color: "var(--color-text-3)",
            }}
          />
          {data.datasets.map((ds, i) =>
            chartType === "line" ? (
              <Line
                key={ds.label}
                type="monotone"
                dataKey={ds.label}
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth={2}
                dot={false}
              />
            ) : (
              <Bar
                key={ds.label}
                dataKey={ds.label}
                fill={CHART_COLORS[i % CHART_COLORS.length]}
                radius={[3, 3, 0, 0]}
              />
            )
          )}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
};

const FormEl: React.FC<{ el: A2UIForm }> = ({ el }) => {
  const onAction = useA2UIAction();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const f of el.fields) {
      init[f.name] =
        f.inputType === "checkbox"
          ? f.defaultValue === "true"
          : (f.defaultValue ?? "");
    }
    return init;
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const actionId = el.actionId ?? "form_submit";
    onAction(actionId, values);
  };

  return (
    <Form
      layout="vertical"
      colon={false}
      onSubmit={handleSubmit}
      className="mb-2.5 rounded-md border border-border-1 bg-fill-1 p-4"
    >
      {el.fields.map((field) => (
        <Form.Item
          key={field.name}
          label={field.inputType !== "checkbox" ? field.label : undefined}
        >
          {field.inputType === "text" && (
            <Input
              value={values[field.name] as string}
              onChange={(val) =>
                setValues((prev) => ({ ...prev, [field.name]: val }))
              }
            />
          )}

          {field.inputType === "select" && (
            <Select
              value={values[field.name] as string}
              options={(field.options ?? []).map((opt) => ({
                label: opt,
                value: opt,
              }))}
              onChange={(val) =>
                setValues((prev) => ({ ...prev, [field.name]: val as string }))
              }
            />
          )}

          {field.inputType === "checkbox" && (
            <Checkbox
              checked={values[field.name] as boolean}
              onCheckedChange={(checked) =>
                setValues((prev) => ({ ...prev, [field.name]: checked }))
              }
            >
              {field.label}
            </Checkbox>
          )}
        </Form.Item>
      ))}

      <Button variant="primary" htmlType="submit" className="mt-1">
        {el.submitLabel ?? "Submit"}
      </Button>
    </Form>
  );
};

// ─── public API ────────────────────────────────────────────────────────────────

/**
 * Renders a single A2UIElement as a native React node.
 * Requires an A2UIActionProvider ancestor for button/form interactions.
 */
export function renderA2UIElement(
  el: A2UIElement,
  index: number
): React.ReactNode {
  switch (el.type) {
    case "heading":
      return <HeadingEl key={index} el={el} />;
    case "text":
      return <TextEl key={index} el={el} />;
    case "code":
      return <CodeEl key={index} el={el} />;
    case "html":
      return <HtmlEl key={index} el={el} />;
    case "image":
      return <ImageEl key={index} el={el} />;
    case "button":
      return <ButtonEl key={index} el={el} />;
    case "divider":
      return <DividerEl key={index} />;
    case "list":
      return <ListEl key={index} el={el} />;
    case "table":
      return <TableEl key={index} el={el} />;
    case "chart":
      return <ChartEl key={index} el={el} />;
    case "form":
      return <FormEl key={index} el={el} />;
    default: {
      const unknown = el as { type: string; content?: string };
      return (
        <div key={index} className="mb-2.5 text-sm text-text-3">
          {unknown.content ?? ""}
        </div>
      );
    }
  }
}

/**
 * Parse a JSONL string into A2UIElement[]. Lines that fail to parse are
 * surfaced as `{ type: "text", content: line }` so partial streams render
 * gracefully.
 */
export function parseA2UILines(lines: string[]): A2UIElement[] {
  return lines.map((line) => {
    try {
      return JSON.parse(line) as A2UIElement;
    } catch {
      return { type: "text", content: line } as A2UIElement;
    }
  });
}
