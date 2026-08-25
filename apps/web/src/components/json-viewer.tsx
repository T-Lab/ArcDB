"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { jsonText } from "../lib/format";

export function JsonViewer({
  value,
  label = "JSON",
}: {
  value: unknown;
  label?: string;
}): React.JSX.Element {
  const text = jsonText(value);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <div className="json-viewer">
      <div className="json-toolbar">
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
