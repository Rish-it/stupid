import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { ago, api, useLoad } from "./api";
import type { AgentRun, AssetKind, CustomAgent, CustomResult } from "./api";
import { Modal } from "./Surface";

const reads: Record<AssetKind, string> = { whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger", ads: "your ads" };
const list = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** "Every evening at 7 PM" for "19:00". */
function when(at: string) {
  const [h, m] = at.split(":").map(Number);
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `Every ${part} at ${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** The agent in one paragraph: name, when, what it reads, what it does. */
const described = (a: CustomAgent) => `${when(a.at)}. ${a.channels.length ? `Reads ${list(a.channels.map(c => reads[c]))}. ` : ""}${a.does}`;

/** Agents the owner writes in their own words, opened from the Agents heading. Each runs on its own time and on Run now; what it drafts still waits for a tap. */
export default function OwnAgents({ runs, ready, onStarted }: { runs: AgentRun[]; ready: boolean; onStarted: () => void }) {
  const mine = useLoad("custom-agents", api.customAgents);
  const [open, setOpen] = useState<"list" | "make">();
  const agents = mine.data?.agents ?? [];
  const change = (next: CustomAgent[]) => mine.setData({ agents: next });
  const close = () => setOpen(undefined);
  return (
    <>
      {agents.length > 0 && <Button label={`Your agents (${agents.length})`} onClick={() => setOpen("list")} />}
      <Button label="Create your own agent" onClick={() => setOpen("make")} />
      {open === "list" && <Modal isOpen onClose={close} title="Your own agents" width={agents.length > 1 ? 960 : 560}
          subtitle="Each runs every day at its time, or when you tap Run now. Anything it writes for a customer waits for your tap."
          footer={<><Button label="Create your own agent" onClick={() => setOpen("make")} /><Button label="Close" onClick={close} /></>}>
          {agents.length ? <div className="agent-list">
            {agents.map(a => <Own key={a.id} agent={a} run={runs.find(r => r.agent === `custom:${a.id}`)} ready={ready} onStarted={onStarted}
              onChange={next => change(next ? agents.map(x => x.id === a.id ? next : x) : agents.filter(x => x.id !== a.id))} />)}
          </div> : <Text as="p" type="supporting">You have no agents of your own now.</Text>}
        </Modal>}
      {open === "make" && <Make onMade={a => change([...agents, a])} onClose={() => setOpen(agents.length ? "list" : undefined)} />}
    </>
  );
}

function Make({ onMade, onClose }: { onMade: (agent: CustomAgent) => void; onClose: () => void }) {
  const [job, setJob] = useState("");
  const [error, setError] = useState("");
  const [made, setMade] = useState<CustomAgent>();
  const create = () => api.createAgent(job.trim()).then(a => { setMade(a); onMade(a); }, (cause: unknown) => setError(message(cause)));
  return (
    <Modal isOpen onClose={onClose} title={made ? made.name : "Create your own agent"} purpose="form"
      subtitle={made ? undefined : "Muse Spark reads your words and works out when it runs, what it reads and what it drafts."}
      footer={made ? <Button variant="primary" label="Done" onClick={onClose} />
        : <><Button variant="ghost" label="Cancel" onClick={onClose} /><Button variant="primary" label="Create agent" isDisabled={job.trim().length < 10} clickAction={create} /></>}>
      {made ? <VStack gap={2}>
          <Text as="p">{described(made)}</Text>
          <Text as="p" type="supporting" size="sm">Anything it writes for a customer waits for your tap. Switch it off or delete it any time.</Text>
        </VStack>
        : <TextArea label="What should it do?" rows={4} maxLength={600} value={job} onChange={v => { setJob(v); setError(""); }}
          placeholder="Every evening, tell me which customers asked about bulk orders and draft a quote for each."
          status={error ? { type: "error", message: error } : undefined} />}
    </Modal>
  );
}

function Own({ agent, run, ready, onStarted, onChange }: {
  agent: CustomAgent; run?: AgentRun; ready: boolean; onStarted: () => void; onChange: (next: CustomAgent | null) => void;
}) {
  const [error, setError] = useState("");
  const fail = (cause: unknown) => setError(message(cause));
  const running = run?.status === "running";
  const result = run?.status === "done" ? run.result as unknown as CustomResult | null : null;
  return (
    <article className="agent-tile" data-mode={agent.on ? "draft" : "off"} aria-labelledby={`own-${agent.id}`}>
      <VStack gap={1}>
        <Heading level={3} id={`own-${agent.id}`} className="agent-name">{agent.name}</Heading>
        <Text as="p" size="sm" type="supporting">{described(agent)}</Text>
      </VStack>
      <div aria-live="polite">
        {error && <Text as="p" size="sm">{error}</Text>}
        {running && <Text as="p" size="sm" className="shimmer">Working on it. This usually takes under a minute.</Text>}
        {run?.status === "failed" && <Text as="p" size="sm">The last run didn't finish: {run.error ?? "no reason given"}</Text>}
        {result && <Text as="p" size="sm">{result.summary}{run?.finished ? ` (${ago(run.finished)})` : ""}</Text>}
        {result && result.drafts > 0 && <Text as="p" size="sm" type="supporting">{result.drafts === 1 ? "1 draft waits" : `${result.drafts} drafts wait`} in Needs you on Home.</Text>}
      </div>
      <HStack gap={2} align="center" wrap="wrap">
        <Button variant="primary" size="sm" label={running ? "Working…" : "Run now"} isLoading={running} isDisabled={!ready}
          aria-label={running ? `${agent.name} is working` : `Run now: ${agent.name}`}
          clickAction={() => api.runAgent(agent.id).then(() => { setError(""); onStarted(); }, fail)} />
        <Button variant="ghost" size="sm" label="Delete" aria-label={`Delete ${agent.name}`}
          clickAction={() => api.deleteAgent(agent.id).then(() => onChange(null), fail)} />
      </HStack>
      <Switch label={agent.on ? "On: runs every day" : "Off"} value={agent.on} onChange={on => void api.switchAgent(agent.id, on).then(onChange, fail)} />
    </article>
  );
}
