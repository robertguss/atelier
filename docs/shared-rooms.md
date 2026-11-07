# Shared rooms

A shared room is an Atelier room with a second person in it. Robert invites a
teammate to one room. Both sign in to the web app with their own accounts and
work with the same agents (Claude Code, Codex and Pi) on Robert's runner. Either
person can message an agent, steer it, stop it and answer its questions. They
also share the room document with the agents (see [the room
document](room-document.md)), and have a team chat that the agents never see.

Robert is the owner. Only he creates rooms, invites and removes people, chooses
the room's agents, sets the edit switch and runs independent reviews. A teammate
sees only the rooms they were invited to.

Robert creates rooms from the phone app, or from the web app with **New room**
on the room list (see [creating a room on the web
app](room-document.md#creating-a-room-on-the-web-app)). The web app opens the
rooms you belong to.

## Inviting a teammate

1. Open the room in the web app and select **Members**.
2. Under **Invite someone**, enter the teammate's email address and select
   **Invite**.
3. Copy the link it shows and send it to them yourself.

An invite is for that one room and that one email address. It works once and
lasts 7 days. Clerk never emails anyone: the link you send is the only way in.
If the address has no Atelier account yet, the link is a Clerk invitation that
lets them create the account and then brings them to the invite; sign-up is
otherwise closed. Anyone holding that link can create the account, so send it
privately, such as in a Slack DM.

Whoever opens the link must be signed in with the invited address. Someone
signed in with another address sees which address the invite was for, partly
masked, and cannot join. Pending invites are listed in **Members**, where
**Revoke** cancels one. An invite to a second room is a second invite.

**Members** refuses an invite to someone already in the room, the owner
included, and to an address that already has an unexpired pending invite. A
removed teammate can be invited again. If the server has no Clerk key or web
address set, **Members** says invites aren't set up yet.

### The join notice

Before a teammate enters a room for the first time, they must accept a notice
that says:

- team chat and agent activity in the room are recorded permanently;
- the agents run on Robert's machine;
- their prompts can reach anything Robert's agents can, including files outside
  the room's folder and Robert's connected tools;
- the room document is shared with the agents and kept permanently.

The agents keep their full reach in shared rooms. They load Robert's skills,
MCP servers, connectors and extensions as usual. Invite only people you would
trust with that. If the notice text ever changes, members are asked to accept
it again. The owner does not see the notice.

### Removing a teammate

In **Members**, select **Remove** next to the person, then confirm. They lose
access to the room at once. Messages they left waiting for an agent are
cancelled and never delivered, including @mentions in their comments that no
model has answered yet. Any block they were editing is released. What they
already wrote stays, with their name on it.

Then rotate the runner secret (see [Operator setup](#after-removing-a-member)).
Under full reach, a teammate's prompt can have an agent read
`runner/.env.local`, and removing them cannot revoke a copy they already took.

## The room layout

The room opens on the document, with the agent pane to its left and the team
pane to its right. Either side panel folds away with **Hide agents** or **Hide
team chat** and shows a badge while folded: open questions or "Working" for the
agents, unread messages for team chat. On a narrow window the document fills
the room, and **Agents** and **Team chat** in the header open the panels. See
[the room layout](room-document.md#the-room-layout).

- **The agent pane** shows each agent's status, the messages people sent to
  agents, the agents' streamed replies and tool activity, question cards, and
  what is queued. It opens on the latest 40 turns; **Show earlier** at the top
  loads 40 more. Its composer is labelled with the agent it writes to, for
  example "To Claude". With more than one agent, pick the target above the box.
- **The team pane** is chat between the people only. Its composer reads "To
  team only". Nothing the agents read is built from team chat: not their
  prompts, not their room context, not decisions. Agents are told only that a
  private team channel exists. Team messages cannot be edited or deleted.

In both composers, Enter sends and Shift+Enter adds a line. Enter only sends
from the box that has focus, so a message meant for your teammate cannot reach
an agent by accident.

## Talking to an agent: queue or steer now

A message to an idle agent starts a turn at once. Each turn's prompt says who
is in the room and wraps every message in a tag with its author's name and
role, so the agent knows who asked what.

A message to an agent that is working waits in its queue. When the turn ends,
everything waiting goes in together, in send order, as the next turn. The queue
is listed under the agent pane.

To change the agent's direction without waiting, use **Steer now** on a queued
message, or **Send and steer now** in the composer while the agent works. The
message goes into the running turn. Claude takes it at its next tool result,
Codex after its running command, and Pi before its next model call. If the
harness can no longer take it, for example because the turn just ended, the
message goes back to the queue and runs as the next turn. A follow-up to an
independent review never takes a steer.

The steer buttons appear only while the agent's turn can take a steer: not
during a scribe run, a turn answering a thread mention or a review follow-up.
While Claude waits on a command it moved to the background, it still takes a
steer, which starts at once. A steered message shows inside the turn it went
into, before that turn's answer.

Anyone in the room can stop a running turn. The agent's next prompt says who
stopped it.

## Question cards

When an agent asks a question through its own question tool, the room shows a
question card above the composer. A card holds one to four questions with
options and room for a free answer. Either person can answer it. The first
complete answer wins, and the card shows who answered. Sending a chat message
to an agent that is waiting on its card also answers the card, with that
message as the free answer.

Each answer on the card is recorded as one decision per question, linked to
the team messages posted while the card was open (by id only). A chat answer
reaches the agent as the answer to every question, and Claude is told that the
one message answers them all. It is recorded as one decision for the whole
card. Recent decisions appear in every agent's room
context. A card left unanswered for 2 hours closes with no decision, and
stopping the turn cancels its card.

Claude raises cards through its own question tool, and Codex and Pi through
the room's `raise_hand` tool, which asks one question at a time. A raised card
also pushes to the owner's phone; tapping it opens the room with that agent
selected and its question shown above the composer, where a reply answers it.

## The edit switch

The header has an **Agents may edit files in this folder** switch. It is off by
default. Only the owner can change it, and everyone sees its state. With it on,
agents can edit files inside the room's folder without asking. It never widens
which commands they can run.

Inside the folder, these control files and folders stay protected at any depth,
because writing one could give an agent new commands, hooks or extensions on a
later turn: `.claude`, `.mcp.json`, `.codex`, `.pi`, `.agents` and `.git`.
Writes that resolve outside the folder through a symlink are blocked too.

- **Claude.** A permission callback allows Edit and Write inside the folder
  while the switch is on and denies every other tool that is not already
  approved. Tools approved in Robert's Claude settings still run, and Claude
  Code itself still auto-approves Bash commands it classes as read-only.
  Changing the switch takes effect in a running turn.
- **Codex.** With the switch on, Codex runs in a workspace-write sandbox that
  asks before changes. The runner declines every command that asks for
  approval, and accepts a file change only when all its paths are inside the
  folder and outside the protected names. With the switch off, Codex runs in
  the read-only sandbox.
- **Pi.** With the switch on, Pi gets its edit and write tools plus a runner
  guard extension that blocks writes outside the folder and to protected names.
  With it off, Pi has only read, grep, find and ls. Pi never gets a shell.

For Codex and Pi, turning the switch on applies from their next turn. Turning
it off stops a running Codex or Pi turn.

## Independent reviews

Reviews stay owner-only in shared rooms. A teammate never sees review turns,
answers or follow-ups. Every follow-up to a review runs on a separate session
kept with the review, even when Robert is alone in the room, so the agent
cannot later repeat the review to a teammate or write it into the room
document. Follow-ups can read the document but never change it, and reviews
never see it at all (see [what the agents
see](room-document.md#what-the-agents-see)). Follow-ups that ran on the agent's
ordinary session before rooms had a document are still covered: when the first
teammate joins, those agents start a fresh session. See
[independent review](independent-review.md).

## When the runner is offline

The runner sends a heartbeat every 15 seconds. After 45 seconds without one,
the room shows a banner and messages to agents are refused with an error. Team
chat and the document still work. Messages that were waiting in a queue are
cancelled as "runner offline" rather than held. An @mention in a comment is the
exception: it waits and runs when the runner is back.

If the runner stops in the middle of a turn, a backend job fails the turn within
about 6 minutes, once its 5-minute lease runs out, and closes its open cards
with no decision.
When the runner restarts, it marks its unfinished turns interrupted. Nothing
retries an ordinary turn on its own: send the message again.

## Operator setup

### Clerk

Use the existing Clerk development instance, the one the phone app signs in
with.

1. In the Clerk dashboard's restriction settings, set the sign-up mode to
   **Restricted**. Strangers then cannot create accounts. Atelier's invites
   bring new teammates in through Clerk invitations.
2. Copy the instance's secret key for the Convex step below. Never commit it.

`ATELIER_OWNER_EMAILS` (already set) still decides who is the owner.

### Convex

From `packages/backend`, set the two new environment variables on the
deployment the apps use:

```sh
npx convex env set CLERK_SECRET_KEY <secret key from Clerk>
npx convex env set ATELIER_WEB_URL https://<web app domain>
```

`ATELIER_WEB_URL` is where teammates open the web app. Invite links are built
from it, so set it to the Vercel production domain.

Then push the backend:

```sh
npx convex dev --once
```

`convex codegen` alone does not push functions. Update the phone app at the
same time as the backend: the phone now calls `users.ensure` on sign-in, which
links the owner to rooms made before memberships existed. An old phone against
the new backend sees no rooms until that runs, and a new phone fails against
the old backend.

### Vercel

Create a Vercel project from this repository with:

- **Root directory:** `apps/web`
- **Framework preset:** Vite (build `vite build`, output `dist`)
- **Environment variables:** `VITE_CONVEX_URL` (the deployment's
  `https://<deployment>.convex.cloud` URL) and `VITE_CLERK_PUBLISHABLE_KEY`
  (the same `pk_test_...` key the phone uses)

`apps/web/vercel.json` rewrites every path to `index.html`, so invite and room
links load the app directly. The generated Convex API is committed, so the
build needs no Convex access.

### Local development

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the same two
variables. Then run:

```sh
pnpm --filter @atelier/web dev
```

To open it from another machine, use the exe.dev HTTPS proxy
(<https://exe.dev/docs/proxy.md>).

### After removing a member

Rotate `ATELIER_RUNNER_SECRET`, then restart the runner:

```sh
pnpm --filter @atelier/runner rotate-secret
```

It generates a new secret, sets it on Convex, and writes it to
`runner/.env.local`, without printing it. If Convex refuses, nothing changes.
Until you restart the runner it is refused, so agents look offline.

The runner keeps the secret out of the environment its agents inherit, so an
agent cannot simply print it. Under full reach an agent can still read
`runner/.env.local`, which is why removal calls for a new secret.

### Checking it works

Sign in to the web app in two browsers, as Robert and as a second account you
invited. Check that the teammate sees the notice, that team chat never shows in
an agent's reply, that both of you can queue, steer and stop a turn, that a
Claude card can be answered from either browser, and that the edit switch
allows an edit in the folder and blocks one to `.git`. In the document, check
that one browser sees "is editing" while the other edits a block, and that an
@mention in a comment gets a reply in its thread.
