"use client";

import { useEffect, useRef, useState } from "react";
import { repairPartialEnvelope, validateEnvelope, type Envelope } from "@/lib/genui/envelope";
import { coerceUi } from "@/lib/genui/partial";

const THROTTLE_MS = 120;

/** The final envelope for a finished tool input: strict if valid, otherwise whatever is renderable. */
export function finalEnvelope(input: unknown): Envelope | null {
  const ui = coerceUi(input); // models sometimes send the UI as a JSON string
  const v = validateEnvelope(ui);
  return v.envelope ?? repairPartialEnvelope(ui);
}

/**
 * Turns the model's growing `ui` tool input into envelopes to render: while streaming it repairs the partial tree
 * (leading + trailing throttle, so the iframe is updated at ~8 Hz at most); once finished it uses the validated one.
 */
export function useGenuiEnvelope(ui: unknown, streaming: boolean): Envelope | null {
  const [env, setEnv] = useState<Envelope | null>(() => (streaming ? repairPartialEnvelope(coerceUi(ui)) : finalEnvelope(ui)));
  const latest = useRef(ui);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRun = useRef(0);

  useEffect(() => {
    latest.current = ui;
    const apply = () => {
      timer.current = null;
      lastRun.current = Date.now();
      const next = streaming ? repairPartialEnvelope(coerceUi(latest.current)) : finalEnvelope(latest.current);
      setEnv((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    if (!streaming) {
      if (timer.current) clearTimeout(timer.current);
      apply();
      return;
    }
    if (timer.current) return; // a trailing update is already scheduled and will read `latest`
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastRun.current));
    timer.current = setTimeout(apply, wait);
  }, [ui, streaming]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return env;
}
