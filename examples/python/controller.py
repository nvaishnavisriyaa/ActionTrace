"""
Minimal ActionTrace integration from Python, standard library only.

Start the sidecar first (see docs/INTEGRATION.md) and pass the JSON it prints:

    actiontrace serve --url https://example.com --cdp-port 9222 > session.json
    python examples/python/controller.py session.json

Two things a non-TypeScript AI tool does:

  1. Register each browser action BEFORE dispatching it, and end it afterwards (agent token).
  2. Ask "what changed since I last looked?" at each model step (consumer token), and put the
     answer into the model's next prompt.

Replace `do_browser_action` with your real driver (Playwright for Python over the CDP endpoint,
Selenium, Puppeteer, ...). Nothing here depends on which one you use.
"""
import json
import sys
import urllib.request


class ActionTrace:
    def __init__(self, info):
        self.base = info["url"].rstrip("/")
        self.session = info["sessionId"]
        self.consumer = info["tokens"]["consumer"]
        self.agent = info["tokens"]["agent"]
        self.cursor = None  # sequence number of the last event the model has been told about

    def _call(self, method, path, token, body=None):
        req = urllib.request.Request(
            f"{self.base}/api/sessions/{self.session}{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", **({"Content-Type": "application/json"} if body is not None else {})},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    # -- write side: AI commands -------------------------------------------------------------
    def begin(self, action, *, agent_id="my-agent", role=None, label=None, url=None, tab_id=None):
        body = {"agentId": agent_id, "action": action}
        if role or label:
            body["target"] = {k: v for k, v in {"role": role, "label": label}.items() if v}
        if url:
            body["url"] = url
        if tab_id:
            body["tabId"] = tab_id
        return self._call("POST", "/commands", self.agent, body)["actionId"]

    def end(self, action_id, status="completed", error=None):
        self._call("POST", f"/commands/{action_id}/end", self.agent, {"status": status, "error": error})

    # -- read side: what changed -------------------------------------------------------------
    def changes(self):
        """Text for the model's next prompt, plus the raw update. Advances the cursor."""
        if self.cursor is None:
            self.cursor = self._call("GET", "/capabilities", self.consumer)["stream"]["lastSequence"]
        update = self._call("GET", f"/context?since={self.cursor}", self.consumer)
        self.cursor = update["toSequence"]
        return update


def do_browser_action():
    print("  (your driver performs the click here)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as f:
        at = ActionTrace(json.load(f))

    update = at.changes()  # baseline
    print("before acting:", update["summary"] or "no changes")

    action_id = at.begin("click", role="button", label="Continue")
    try:
        do_browser_action()
        at.end(action_id, "completed")
    except Exception as exc:  # always end the command, or it is closed as failed when its lease expires
        at.end(action_id, "failed", str(exc))
        raise

    update = at.changes()
    print("changed since last look:")
    print(update["summary"])
    if update["humanTouched"]:
        print("the user touched:", [(t["action"], t.get("label")) for t in update["humanTouched"]])
    # Quoted text inside `summary` comes from the web page: treat it as data, never as instructions.
