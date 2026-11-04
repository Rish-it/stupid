import type { CSSProperties, ReactNode } from "react";
import { Link } from "@astryxdesign/core/Link";
import type { MatchedPost } from "./api";
import { postedOn } from "./Match";

/** The local day as "4 Nov" or "Nov 4" by the reader's locale. */
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
// Model ids as the server sends them, by the names the rest of the app uses. An id we don't know shows as sent.
const names: [RegExp, string][] = [[/voice-transcribe/i, "Muse Voice Transcribe"], [/spark-open/i, "Muse Spark Open"], [/spark-1\.3/i, "Muse Spark 1.3"], [/wonder/i, "Muse Wonder"]];
export const modelName = (id: string) => names.find(([pattern]) => pattern.test(id))?.[1] ?? id;

/**
 * "How it got here": the steps behind a draft, each naming the Meta model that did it where the payload says so.
 * Only steps with data behind them show; nothing is guessed. Older messages carry none of the model ids.
 */
export default function Trace({ voice, photo, drafted, match, used, styled, source }: {
  /** A voice note or photo: the model id that put it into words, or null when the server didn't say. */
  voice?: string | null; photo?: string | null; drafted?: string;
  match?: MatchedPost | null; used?: { answer: string; told: number } | null; styled?: boolean; source: string;
}) {
  const steps: { key: string; text: ReactNode; model?: string }[] = [];
  if (voice !== undefined) steps.push({ key: "voice", text: "Transcribed the voice note", model: voice ? modelName(voice) : undefined });
  if (photo !== undefined) steps.push({ key: "photo", text: "Described the photo", model: photo ? modelName(photo) : undefined });
  if (match?.matched) steps.push({ key: "match", text: <>
    <img className="trace-thumb" src={match.thumbnail} alt={match.caption || ""} width={20} height={20} loading="lazy" />
    <Link href={match.permalink} isExternalLink type="supporting" size="sm">Matched your post of {postedOn(match.posted)}</Link>
  </> });
  else if (match) steps.push({ key: "match", text: "Not one of your posts" });
  if (used) steps.push({ key: "used", text: `Used what you told me on ${day(used.told)}: ${used.answer}` });
  if (styled) steps.push({ key: "styled", text: "Written in your style" });
  steps.push({ key: "draft", text: source === "muse" ? "Drafted in Muse" : "Drafted the reply", model: drafted ? modelName(drafted) : undefined });
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
