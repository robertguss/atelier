# The room document

Every room has a document: a shared, current record of the work that the
people in the room and its agents keep together. It holds what has happened,
findings, ideas, changes of direction and open questions. Robert and a
teammate edit it in the web app. The agents read it at the start of their
turns and add to it on their own.

The document is made of blocks. A block is one heading, paragraph or list item.
A heading and the blocks under it form a section.

Rooms made before the document existed get one from the default template the
first time someone opens them.

## The room layout

On a laptop or any wide window, the room opens on the document. The agent pane
sits to its left and team chat to its right. The first time you open a room,
the agent pane is open and team chat is folded. After that, each panel opens
the way you last left it in that room, in that browser.

- **Hide agents** and **Hide team chat** fold a panel into a narrow strip at the
  edge of the window. Select the strip (**Show agents** or **Show team chat**)
  to open it again.
- A folded agent pane shows a badge: "1 question" (or "2 questions", and so on)
  when a question card is waiting, otherwise "Working" while an agent runs.
- A folded team chat shows how many messages from others arrived since you
  last had it open, for example "3 unread".
- Drag the line between a panel and the document to resize it, or focus the
  line and use the arrow keys. A panel takes at most 40% of the width.

On a narrow window the document fills the room, and **Agents** and **Team
chat** in the header open the panels as sheets. They show the same badges.

The document header reads "Shared with everyone in the room, agents included."
It holds **Call in the scribe**, **History** and, for Robert only, **Save as
template**.

## Writing in the document

People can edit any block, whoever wrote it.

- **Edit** opens a block for editing. Enter saves, Shift+Enter adds a line, and
  clicking away also saves.
- **Add below** adds a block after this one. **Add to** *section name* at the
  end of each section adds one there. Pick **Heading**, **Paragraph** or
  **List item**; the new block opens for editing and you are its author.
- **Move up** and **Move down** move a block one place.
- **Delete** asks "Delete this block? History keeps a copy." Select **Delete
  this block** to go ahead, or **Keep it**.

The buttons appear when you point at or focus a block. Each block shows its
author underneath. Editing someone else's block does not change its author.

### Edit locks

Opening a block for editing takes a lock on it. While you hold it, others see
"*name* is editing" on the block and cannot edit, move or delete it. The
browser renews the lock while you type. It lapses about two minutes after your
last renewal, so a block left open and idle frees itself.

If your lock lapsed before you saved, the save is refused with "Your edit lock
on this block has lapsed" and your draft stays in the box. **Retake the block**
takes the lock again so you can save. If someone else has taken the block in
the meantime, **Copy my draft** copies your text instead. **Discard my draft**
gives it up.

### What the models do

The models are told to keep the document current without being asked:
whenever something in the session is worth keeping, they add a short block in
the section it belongs to. They can update and delete only blocks they wrote
themselves. To respond to anyone else's block, a model comments on it.

A model never takes a lock, and a model write is refused while a person is
editing that block. A model's update must name the version of the block it
read. If anyone changed the block since then, nothing is written; the model
gets the current text and is told to build on it rather than undo the change.
A model cannot delete one of its own blocks once a person has edited it.

## Comments

1. Select a passage of text in a block.
2. Select **Comment** beside the block's author.
3. Write your comment and select **Post comment** (or press Enter).

Threads appear beside the document, in the order of their blocks. A block with
open threads shows "1 open thread" (or more). In browsers that support it, the
commented passages are highlighted.

Any open thread takes a **Reply**. Models also comment, but a model's comment
never calls anyone in.

### Asking a model

Type @ in a comment or reply to pick one of the room's models, for example
@Claude. The model reads the passage and the thread so far, and its answer is
posted as its reply in the thread, not in the agent chat. A mention runs as a
turn of its own once the model is free.

Under the comment, each mention shows where it stands:

- "waiting for *model*": queued until the model is free;
- "waiting for the runner": the runner is offline. The comment is saved, and
  the mention runs when the runner is back;
- "*model* is answering";
- "*model* replied";
- "*model* could not reply": its turn failed or was stopped;
- "mention of *model* cancelled".

### Settling threads

**Settle** closes a thread once it is dealt with. Settled threads move into
**Settled** at the bottom of the comments, folded and with a count; select it
to show them. **Reopen** brings one back. Only people settle or reopen threads.

### When the passage is gone

A thread follows its passage as the block changes. If the passage is edited
away or its block is deleted, the thread stays in the list marked "Passage
removed". **View original** shows the document as it stood just before the
change that removed it, with the commented block marked. If the passage comes
back, for example after a restore, the thread attaches to it again.

## The scribe

The scribe is one of the room's models, called in to reorganize the whole
document in one go: merging notes that overlap, cutting repetition and moving
blocks into the sections they belong in. It is told to keep each side of a
disagreement with whose view it is, and not to drop open questions.

Either person in the room can call it in.

1. Select **Call in the scribe** in the document header.
2. Choose which model acts as scribe.

It is refused, with the reason, while someone is editing a block ("*name* is
editing a block"), while that model is still answering a message, while the
runner is offline, and while a scribe is already working.

While the scribe works, a banner reads "The scribe is working", with the model,
who started it and how long it has run. The document is read-only for everyone:
nobody can edit, add, move or delete blocks or restore a version, and the
models' own writes are refused. Comments keep working, for people and models.
The scribe never edits files in the room's folder.

Its changes reach the document all at once when its turn ends, as one entry in
history. Blocks it did not touch stay exactly as they were. Comment threads
follow their passages into the rewritten blocks; a thread whose passage is gone
is marked "Passage removed".

**Stop** on the banner ends the run. Anyone in the room can stop it. A stopped
or failed run changes nothing. A run has at most 35 minutes. After that the
document unlocks and the run ends unchanged as "The scribe run ran out of
time".

When the run ends, the people who had the document open see how it went:

- "*model* finished the scribe run. Its changes are one entry in history." with
  **See it in history**;
- "*model* finished the scribe run without changing the document.";
- "*name* stopped the scribe run. The document is unchanged.";
- "The scribe run failed: *reason*. The document is unchanged."

### Credits

A block the scribe writes is credited to the authors of the blocks it drew on,
for example "Scribe (Claude), from Robert, Ana". Credits come from those
blocks' authors, never from the scribe's own judgement. Blocks it only moves
keep their author.

A scribe block belongs to no model, so no model can update or delete it later;
models comment on it like anyone else's. People can edit it as usual.

## History and restore

**History** lists every change to the document, newest first:

- "Template seeding by *name*": the room's starting sections;
- "Edit by *name*": everything one person wrote in one block under one edit
  lock, or one move or delete;
- "*model*'s turn": everything a model wrote in one turn;
- "Scribe run by *model*, started by *name*";
- "Restore by *name*".

**Load older versions** reaches further back. Select an entry to see the
document as it stood after it, read-only, with the blocks that change touched
marked **Added**, **Changed**, **Moved** or **Removed**.

**Restore this version** returns every block to its text, kind, place and
author in that version. Blocks deleted since come back; blocks added since are
removed. The current document is saved in history first, so nothing is lost,
and the whole restore is one new entry. Comment threads stay and follow the
restored text. Either person can restore. A restore is refused while someone is
editing a block or the scribe is working.

## Templates

A new room's document starts from a template: a list of section headings, each
with optional guidance that appears as a paragraph under the heading. Atelier's
default has three sections and no guidance: "What's happened", "Ideas & notes"
and "Open questions".

Robert writes his own templates. On the web app's room list, select
**Templates**, then **New template**. Give it a **Template name**, fill in each
section's heading and guidance, use **Add section** for more, and select **Save
template**. **Edit** and **Delete** change or remove a template. Rooms already
made from a deleted template keep their documents.

**Save as template** in a room's document header saves that room's sections as
a new template, under the name you give it: its headings, and the template
guidance under them that nobody has changed. Nothing anyone wrote in the room
is copied.

### Creating a room on the web app

Robert can create rooms from the web app as well as from the phone. Select
**New room** on the room list and fill in:

- **Room name**;
- **Project folder**, where the room's agents work;
- **Template**: **Default**, or one of Robert's templates. **Edit templates**
  opens the templates page.

**Runner** shows the runner the room will use. With no runner online, the room
cannot be created. Select **Create room** to open it. A room created on the
phone always starts from the default template.

## What the agents see

- **The document and its comments are visible to every agent in the room.**
  Each turn starts with the document in its prompt: in full when it fits,
  otherwise as an outline with the agent's own blocks in full. A model
  continuing its session is shown what changed since its last turn. It can
  read the rest with its tools. The join notice tells teammates that the
  room document is shared with the agents and kept permanently. Deleting a
  block does not erase it: history keeps every version.
- **Team chat is not.** Nothing in an agent's prompt or document tools comes
  from team chat.
- **Independent reviews never receive the document and cannot write to it.**
  A review's prompt has no document, and its turns get no document tools.
- **Follow-ups to a review can read the document but never write to it.** They
  cannot add, change or delete blocks, or comment. Every follow-up runs on a
  session of its own kept with the review, even when Robert is alone in the
  room, so review content cannot later reach the document through the agent's
  ordinary session. See [shared rooms](shared-rooms.md#independent-reviews).

## Limits

The models work within caps for each turn:

- at most 20 block writes (each add, update or delete counts);
- at most 10 comments.

Everyone, people and models alike, works within the size of the document:

- at most 4,000 characters in a block (models also in a comment);
- no new blocks once the document has 600.

The scribe's changes must also leave the document at 600 blocks or fewer. A
write past a cap is refused, and the model or person is told why. A comment's
quote must appear once in its block, so it lands where the model meant.
