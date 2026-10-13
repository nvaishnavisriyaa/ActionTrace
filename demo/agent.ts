import type { Page } from "playwright-core";
import { PlaywrightAgentActions, type ActionTrace, type PlaywrightAdapter, type TouchedTarget } from "../src/index.js";

export interface AgentLogLine {
  n: number;
  at: string;
  kind: "step" | "context" | "decision" | "info" | "error";
  text: string;
}

interface Step {
  /** Elements the user might have changed that make this step unsafe (labels, matched loosely). */
  guards: string[];
  describe: string;
  run: (a: PlaywrightAgentActions, page: Page) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for an AI tool's browser controller. It shows the intended integration:
 *   1. every browser command goes through ActionTrace (here via PlaywrightAgentActions),
 *   2. before each model step the controller asks "what changed since I last looked?",
 *   3. it adapts instead of overwriting the user's work.
 * A real controller would put `update.summary` into the model's next prompt.
 */
export class DemoAgent {
  readonly lines: AgentLogLine[] = [];
  running = false;
  private abort?: AbortController;
  private counter = 0;

  constructor(
    private readonly trace: ActionTrace,
    private readonly pw: PlaywrightAdapter,
    private readonly page: Page,
    private readonly siteUrl: string,
  ) {}

  stop(): void {
    this.abort?.abort();
  }

  private log(kind: AgentLogLine["kind"], text: string): void {
    this.lines.push({ n: ++this.counter, at: new Date().toISOString().slice(11, 19), kind, text });
    if (this.lines.length > 300) this.lines.shift();
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const { signal } = this.abort;
    const page = this.page;
    const act = new PlaywrightAgentActions(this.trace, this.pw, "agent-1", page);
    try {
      this.log("info", "Agent started. It will fill the order form, one field at a time.");
      await act.goto(this.siteUrl + "/index.html", { signal });
      const feed = this.trace.contextFeed();
      // A controller must remember what the user touched until it has dealt with it: context updates
      // are consumed once, but a later step may still depend on an earlier intervention.
      const userTouched: TouchedTarget[] = [];
      const uncertainTouched: TouchedTarget[] = [];

      const steps: Step[] = [
        { guards: ["Full name"], describe: "fill Full name", run: (a, p) => a.fill(p.getByLabel("Full name"), "Ada Lovelace", { timeout: 4000 }) },
        { guards: ["Email"], describe: "fill Email", run: (a, p) => a.fill(p.getByLabel("Email"), "ada@example.com", { timeout: 4000 }) },
        { guards: ["Basic plan", "Pro plan"], describe: "choose the Pro plan", run: (a, p) => a.check(p.getByLabel("Pro plan"), { timeout: 4000 }) },
        { guards: ["Password"], describe: "fill Password", run: (a, p) => a.fill(p.getByLabel("Password"), "correct-horse-battery", { timeout: 4000 }) },
        { guards: ["Send me product news"], describe: "tick product news", run: (a, p) => a.check(p.getByLabel("Send me product news"), { timeout: 4000 }) },
        { guards: ["Continue"], describe: "click Continue", run: (a, p) => a.click(p.getByRole("button", { name: "Continue" }), { timeout: 4000 }) },
      ];

      for (const step of steps) {
        if (signal.aborted) break;
        await sleep(2200); // time for a person to interject

        // ---- execution boundary: deliver what changed since the last observation to the "model" ----
        const update = feed.next();
        if (update.eventCount > 0) this.log("context", update.summary);
        userTouched.push(...update.humanTouched);
        uncertainTouched.push(...update.uncertainTouched);

        const hits = (list: typeof update.humanTouched) =>
          list.filter((t) => step.guards.some((g) => (t.label ?? "").toLowerCase().includes(g.toLowerCase())));
        const byUser = hits(userTouched);
        const uncertain = hits(uncertainTouched);
        if (byUser.length || uncertain.length) {
          const who = byUser.length ? "the user" : "someone (owner uncertain)";
          const label = (byUser[0] ?? uncertain[0]).label;
          this.log("decision", `Skipping "${step.describe}": ${who} already changed ${JSON.stringify(label)}. Not overwriting.`);
          continue;
        }
        if (update.stale) this.log("decision", "Context is stale; a real controller would re-read the page before acting.");

        this.log("step", step.describe);
        try {
          await step.run(act, page);
        } catch (err) {
          this.log("error", `"${step.describe}" failed: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      const last = feed.next();
      if (last.eventCount > 0) this.log("context", last.summary);
      this.log("info", signal.aborted ? "Agent stopped." : "Agent finished.");
    } catch (err) {
      this.log("error", (err as Error).message.split("\n")[0]);
    } finally {
      this.running = false;
    }
  }
}
