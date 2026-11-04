import type { CSSProperties, ReactNode } from "react";
import { Link } from "@astryxdesign/core/Link";
import type { MatchedPost } from "./api";
import { postedOn } from "./Match";

/** The local day as "4 Nov" or "Nov 4" by the reader's locale. */
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/**
 * "How it got here": the steps behind a draft, each naming the Meta model that did it where the payload says so.
 * Only steps with data behind them show; nothing is guessed.
 */
export default function Trace({ voice, match, used, styled, source }: {
  voice?: boolean; match?: MatchedPost | null; used?: { answer: string; told: number } | null; styled?: boolean; source: string;
}) {
  const steps: { key: string; text: ReactNode; model?: string }[] = [];
  if (voice) steps.push({ key: "voice", text: "Transcribed the voice note", model: "Muse Voice Transcribe" });
  if (match?.matched) steps.push({ key: "match", text: <>
    <img className="trace-thumb" src={match.thumbnail} alt={match.caption || ""} width={20} height={20} loading="lazy" />
    <Link href={match.permalink} isExternalLink type="supporting" size="sm">Matched your post of {postedOn(match.posted)}</Link>
  </> });
  else if (match) steps.push({ key: "match", text: "Not one of your posts" });
  if (used) steps.push({ key: "used", text: `Used what you told me on ${day(used.told)}: ${used.answer}` });
  if (styled) steps.push({ key: "styled", text: "Written in your style" });
  steps.push({ key: "draft", text: source === "muse" ? "Drafted in Muse" : "Drafted the reply" });
  steps.push({ key: "wait", text: "Waiting for your tap" });
  return (
    <div className="trace-box">
    <span className="trace-title" aria-hidden>How it got here</span>
    <ol className="trace" aria-label="How it got here">
      {steps.map((s, i) => (
        <li key={s.key} style={{ "--i": i } as CSSProperties} data-step={s.key}>
          <span className="trace-text">{s.text}</span>
          {s.model && <span className="trace-model">{s.model}</span>}
        </li>
      ))}
    </ol>
    </div>
  );
}
